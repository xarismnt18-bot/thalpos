import json
import pytest
from ai.mqtt_client import SharedMQTTClient
from backend.history_store import HistoryStore


def packet(batch='chip-boot-1',rows=None):
    return json.dumps({'v':2,'batch':batch,'room':'Bedroom','readings':rows if rows is not None else [[60,22,50,1],[30,23,51,1]]})


class Publisher:
    def __init__(self):self.sent=[]
    def publish(self,*a,**kw):self.sent.append((a,kw))


def test_ack_follows_commit_and_retry_survives_store_restart(tmp_path):
    path=str(tmp_path/'history.db');store=HistoryStore(path)
    c=SharedMQTTClient();c._client=Publisher()
    def commit(room,rows,batch):
        store.record_backlog(room,rows,batch)
        assert len(store.rows(0,2000))==2
    c.on_backlog_batch=commit
    assert c.ingest_backlog(packet(),received=1000)==2
    assert c._client.sent[0][0]==(c.backlog_topic+'/ack','chip-boot-1')
    # ACK lost, backend restarts, resend is delayed: same batch does not create
    # new timestamps or extra visits, and is acknowledged again.
    reopened=HistoryStore(path)
    c.on_backlog_batch=lambda room,rows,batch:reopened.record_backlog(room,rows,batch)
    c.ingest_backlog(packet(),received=1030)
    assert len(reopened.rows(0,2000))==2
    assert len(c._client.sent)==2


def test_no_ack_when_storage_fails():
    c=SharedMQTTClient();c._client=Publisher()
    def fail(*args):raise OSError('disk unavailable')
    c.on_backlog_batch=fail
    with pytest.raises(OSError):c.ingest_backlog(packet(),received=1000)
    assert c._client.sent==[]


@pytest.mark.parametrize('raw',[packet(rows=[]),packet(rows=[[1,22,50],[2,999,50]]),packet(batch='bad/id')])
def test_partial_or_invalid_batches_not_acknowledged(raw):
    c=SharedMQTTClient();c._client=Publisher();calls=[]
    c.on_backlog_batch=lambda *args:calls.append(args)
    assert c.ingest_backlog(raw,received=1000)==0
    assert not calls and not c._client.sent


def test_backend_absent_keeps_ack_silent():
    c=SharedMQTTClient();c._client=Publisher()
    assert c.ingest_backlog(packet(),received=1000)==0
    assert not c._client.sent
