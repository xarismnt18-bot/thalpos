"""Health-data boundary tests: UTC, reconciliation, overlaps, privacy and gaps."""
import sqlite3
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend.wearable_api import SleepStore, create_app

TOKEN = 'test-key-' + 'a'*40
HEADERS = {'Authorization': 'Bearer '+TOKEN}


@pytest.fixture
def context(tmp_path):
    store = SleepStore(tmp_path/'sleep.db')
    history = tmp_path/'history.db'
    client = TestClient(create_app(store,history,TOKEN))
    end = datetime.now(timezone.utc).replace(microsecond=0)-timedelta(hours=2)
    start = end-timedelta(hours=8)
    session = {'record_id':'hc-1','modified':end.isoformat(),'start':start.isoformat(),'end':end.isoformat(),
               'stages':[{'start':start.isoformat(),'end':(start+timedelta(hours=2)).isoformat(),'stage':'deep'},
                         {'start':(start+timedelta(hours=2)).isoformat(),'end':end.isoformat(),'stage':'rem'}]}
    payload = {'schema_version':1,'source':'com.xiaomi.fitness','room':'Bedroom',
               'range_start':(start-timedelta(days=1)).isoformat(),
               'range_end':(end+timedelta(hours=1)).isoformat(),'sessions':[session]}
    yield client,store,history,payload
    store.db.close()


def reports(client, room='Bedroom'):
    return client.get('/sessions',params={'room':room},headers=HEADERS).json()


def test_all_health_routes_require_key(context):
    client,*_ = context
    for method,path in [('GET','/status'),('GET','/sessions?room=Bedroom'),('POST','/sync'),('DELETE','/sessions'),('PUT','/ratings')]:
        assert client.request(method,path).status_code==401
        assert client.request(method,path,headers={'Authorization':'Bearer wrong'}).status_code==401
    assert client.get('/docs').status_code==404
    assert client.get('/status',headers=HEADERS).json()['ready']


def test_repeated_sync_and_updated_stages(context):
    client,store,_,payload=context
    for _ in range(2):
        assert client.post('/sync',json=payload,headers=HEADERS).status_code==200
    assert store.db.execute('SELECT count(*) FROM sessions').fetchone()[0]==1
    payload['sessions'][0]['stages'][0]['stage']='light'
    assert client.post('/sync',json=payload,headers=HEADERS).status_code==200
    night=reports(client)['sessions'][0]
    assert night['stage_minutes']=={'light':120,'rem':360}
    assert night['asleep_minutes']==480
    assert night['environment']['coverage']==0
    assert night['environment']['temperature_avg'] is None


def test_snapshot_removes_deleted_records_only_for_same_source(context):
    client,store,_,payload=context
    client.post('/sync',json=payload,headers=HEADERS)
    other=deepcopy(payload);other['source']='other.app'
    client.post('/sync',json=other,headers=HEADERS)
    payload['sessions']=[]
    assert client.post('/sync',json=payload,headers=HEADERS).json()['removed']==1
    assert store.db.execute('SELECT source FROM sessions').fetchall()==[('other.app',)]


def test_cumulative_overlapping_records_not_added(context):
    client,_,_,payload=context
    shorter=deepcopy(payload['sessions'][0])
    shorter['record_id']='old-cumulative-id'
    shorter['end']=shorter['stages'][0]['end'];shorter['stages']=shorter['stages'][:1]
    shorter['modified']=shorter['end']
    payload['sessions'].append(shorter)
    assert client.post('/sync',json=payload,headers=HEADERS).status_code==200
    result=reports(client)
    assert len(result['sessions'])==1 and result['excluded_overlapping']==1
    assert result['sessions'][0]['overlap_warning']
    assert result['sessions'][0]['asleep_minutes']==480


def test_offsets_represent_same_instants_and_room_filtering(context):
    client,_,history,payload=context
    session=payload['sessions'][0]
    start=datetime.fromisoformat(session['start'])
    with sqlite3.connect(history) as db:
        db.execute('CREATE TABLE readings(ts REAL,room TEXT,temperature REAL,humidity REAL)')
        db.executemany('INSERT INTO readings VALUES (?,?,?,?)',[(start.timestamp(),'Bedroom',20,50),
                       (start.timestamp()+30,'Bedroom',22,54),(start.timestamp(),'Other',99,99)])
    session['start']=start.astimezone(timezone(timedelta(hours=3))).isoformat()
    assert client.post('/sync',json=payload,headers=HEADERS).status_code==200
    night=reports(client)['sessions'][0]
    assert night['start']==start.timestamp()
    assert night['environment']['temperature_avg']==21
    assert night['environment']['coverage']<0.01
    assert reports(client,'Other')['sessions']==[]


@pytest.mark.parametrize('bad',['overlap','naive','outside','duplicate','unknown_stage'])
def test_invalid_snapshot_is_atomic_and_does_not_reflect_health_data(context,bad):
    client,store,_,payload=context
    s=payload['sessions'][0]
    if bad=='overlap': s['stages'][1]['start']=s['start']
    if bad=='naive': s['start']=s['start'].split('+')[0]
    if bad=='outside': s['stages'][0]['start']=payload['range_start']
    if bad=='duplicate': payload['sessions'].append(deepcopy(s))
    if bad=='unknown_stage': s['stages'][0]['stage']='secret-invalid-health-value'
    response=client.post('/sync',json=payload,headers=HEADERS)
    assert response.status_code==422
    assert 'secret-invalid-health-value' not in response.text
    assert store.db.execute('SELECT count(*) FROM sessions').fetchone()[0]==0


def test_size_limit_and_delete(context):
    client,store,_,payload=context
    assert client.post('/sync',content=b' '*2_000_001,headers=HEADERS).status_code==413
    client.post('/sync',json=payload,headers=HEADERS)
    assert client.delete('/sessions',headers=HEADERS).json()=={'deleted':True}
    assert reports(client)['sessions']==[]


def test_disabled_without_pairing_key(tmp_path):
    store=SleepStore(tmp_path/'s.db')
    try:
        client=TestClient(create_app(store,tmp_path/'none.db',''))
        assert client.get('/status').status_code==503
    finally: store.db.close()


def test_morning_rating_is_stored_by_wake_up_date_and_survives_a_new_record_id(context):
    client,store,_,payload=context
    client.post('/sync',json=payload,headers=HEADERS)
    night=reports(client)['sessions'][0]
    assert night['rating'] is None and len(night['night'])==10
    body={'room':'Bedroom','night':night['night'],'rating':4}
    assert client.put('/ratings',json=body,headers=HEADERS).json()=={'night':night['night'],'rating':4}
    assert reports(client)['sessions'][0]['rating']==4
    # Mi Fitness re-issues the same night under another record ID: the rating stays
    payload['sessions'][0]['record_id']='hc-2'
    client.post('/sync',json=payload,headers=HEADERS)
    assert reports(client)['sessions'][0]['rating']==4
    assert reports(client,'Office')['sessions']==[]
    body['rating']=None
    client.put('/ratings',json=body,headers=HEADERS)
    assert reports(client)['sessions'][0]['rating'] is None


@pytest.mark.parametrize('body',[{'room':'Bedroom','night':'2026-01-01','rating':6},
                                 {'room':'Bedroom','night':'2026-01-01','rating':0},
                                 {'room':'Bedroom','night':'not-a-date','rating':3},
                                 {'room':'Bedroom','night':'1999-01-01','rating':3},
                                 {'room':'Bedroom','night':'2026-01-01','rating':3,'note':'x'}])
def test_invalid_ratings_are_rejected_without_echoing_them(context,body):
    client,*_=context
    if body['night']=='2026-01-01':
        body['night']=(datetime.now().date()-timedelta(days=1)).isoformat()
    response=client.put('/ratings',json=body,headers=HEADERS)
    assert response.status_code==422
    assert response.json()=={'detail':'Invalid rating: use 1-5 (or null) for a night in the last 90 days'}


def test_deleting_imports_also_deletes_ratings(context):
    client,store,_,payload=context
    client.post('/sync',json=payload,headers=HEADERS)
    night=reports(client)['sessions'][0]['night']
    client.put('/ratings',json={'room':'Bedroom','night':night,'rating':2},headers=HEADERS)
    client.delete('/sessions',headers=HEADERS)
    assert store.db.execute('SELECT count(*) FROM ratings').fetchone()[0]==0
