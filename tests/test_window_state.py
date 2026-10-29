from backend.window_state import WindowStateStore


def test_unknown_persist_confirm_and_room_isolation(tmp_path):
    path=tmp_path/'history.db';s=WindowStateStore(path)
    assert s.snapshot('Bedroom',now=100)['state']=='unknown'
    a=s.declare('Bedroom',True,now=100)
    assert a['state']=='open' and a['since']==100 and a['source']=='manual'
    s.declare('Bedroom',True,now=200)
    a=WindowStateStore(path).snapshot('Bedroom',now=300)
    assert a['since']==100 and a['updated']==200 and len(a['events'])==2
    assert a['events'][-1]['action']=='confirmed'
    assert s.snapshot('Other',now=300)['state']=='unknown'
    assert s.snapshot('Bedroom',now=7400)['needs_confirmation']
    a=s.declare('Bedroom',False,now=7500)
    assert a['state']=='closed' and a['since']==7500 and not a['needs_confirmation']


def test_history_window_and_retention(tmp_path):
    s=WindowStateStore(tmp_path/'history.db')
    s.declare('Bedroom',True,now=1)
    s.declare('Bedroom',False,now=31*86400)
    assert len(s.snapshot('Bedroom',hours=720,now=31*86400)['events'])==1


def test_api_validates_and_shares_declarations(monkeypatch,tmp_path):
    from backend import api
    from fastapi.testclient import TestClient
    monkeypatch.setattr(api,'window_store',WindowStateStore(tmp_path/'history.db'))
    client=TestClient(api.app)
    assert client.get('/window-state?room=Bedroom').json()['state']=='unknown'
    assert client.put('/window-state?room=Bedroom',json={'is_open':True}).json()['state']=='open'
    assert client.get('/window-state?room=Bedroom').json()['source']=='manual'
    assert client.get('/window-state?room=Other').json()['state']=='unknown'
    assert client.put('/window-state?room=Bedroom',json={'is_open':'true'}).status_code==422
    assert client.get('/window-state?room=Bedroom&hours=721').status_code==422
    assert client.get('/window-state').status_code==422
