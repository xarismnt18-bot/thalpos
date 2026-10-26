import subprocess
from unittest.mock import Mock

from backend.sleep_bridge import SleepBridge


def test_not_enabled_without_personal_pairing(tmp_path,monkeypatch):
    monkeypatch.delenv('SLEEP_SYNC_TOKEN',raising=False)
    spawn=Mock()
    monkeypatch.setattr('backend.sleep_bridge.subprocess.Popen',spawn)
    assert SleepBridge(tmp_path).start() is False
    spawn.assert_not_called()


def test_paired_service_uses_same_interpreter_and_is_stopped(tmp_path,monkeypatch):
    monkeypatch.setattr('backend.sleep_bridge.sys.platform','linux')
    monkeypatch.delenv('SLEEP_SYNC_TOKEN',raising=False)
    (tmp_path/'sleep_sync.env').write_text('SLEEP_SYNC_TOKEN='+'x'*43)
    monkeypatch.setattr('backend.sleep_bridge.socket.create_connection',Mock(side_effect=OSError))
    process=Mock();process.poll.return_value=None
    spawn=Mock(return_value=process)
    monkeypatch.setattr('backend.sleep_bridge.subprocess.Popen',spawn)
    bridge=SleepBridge(tmp_path)
    assert bridge.start()
    command=spawn.call_args.args[0]
    assert command[2]=='uvicorn' and '--factory' in command and '127.0.0.1' in command
    assert not any('x'*43 in arg for arg in command)
    assert spawn.call_args.kwargs['cwd']==tmp_path
    bridge.stop()
    process.terminate.assert_called_once()
    assert bridge.process is None


def test_existing_listener_is_never_terminated(tmp_path,monkeypatch):
    monkeypatch.setenv('SLEEP_SYNC_TOKEN','x'*43)
    connection=Mock();connection.__enter__=Mock();connection.__exit__=Mock()
    monkeypatch.setattr('backend.sleep_bridge.socket.create_connection',Mock(return_value=connection))
    spawn=Mock()
    monkeypatch.setattr('backend.sleep_bridge.subprocess.Popen',spawn)
    bridge=SleepBridge(tmp_path)
    assert bridge.start() is False
    bridge.stop()
    spawn.assert_not_called()


def test_stubborn_owned_child_is_killed_after_grace_period(tmp_path,monkeypatch):
    monkeypatch.setattr('backend.sleep_bridge.sys.platform','linux')
    bridge=SleepBridge(tmp_path)
    process=Mock();process.poll.return_value=None
    process.wait.side_effect=[subprocess.TimeoutExpired('uvicorn',5),0]
    bridge.process=process
    bridge.stop()
    process.kill.assert_called_once()


def test_windows_venv_redirector_child_tree_is_stopped(tmp_path,monkeypatch):
    monkeypatch.setattr('backend.sleep_bridge.sys.platform','win32')
    command=Mock()
    monkeypatch.setattr('backend.sleep_bridge.subprocess.run',command)
    bridge=SleepBridge(tmp_path)
    process=Mock();process.pid=12345;process.poll.return_value=None
    bridge.process=process
    bridge.stop()
    assert command.call_args.args[0]==['taskkill','/PID','12345','/T','/F']
    process.terminate.assert_not_called()
