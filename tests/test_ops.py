import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops'))
import relay
import worker

class FakeProcess:
    def __init__(self, *args, **kwargs): self.dead=False
    def poll(self): return -9 if self.dead else None
    def kill(self): self.dead=True
    def wait(self, timeout=None): return -9

class OperationsTests(unittest.TestCase):
    def rule(self):
        return dict(id='a'*32,target_ip='8.8.8.8',target_port=45001,protocol='TCP',listen_port=31000,expires_at=1100,speed_mbps=50,revision=1)
    def test_gost_uses_aggregate_speed_in_bytes_not_per_connection(self):
        config=relay.gost_config(self.rule())
        self.assertEqual(config['limiters'][0]['limits'],['$ 6250000B 6250000B'])
        self.assertEqual(config['services'][0]['forwarder']['nodes'][0]['addr'],'8.8.8.8:45001')
        self.assertNotIn('api',config)
    def test_lease_shorter_than_paid_period_and_network_time(self):
        self.assertEqual(relay.remaining_seconds(self.rule(),1000,1050,3),47)
        self.assertEqual(relay.remaining_seconds(self.rule(),1200,1300),0)
    def test_expiry_kills_existing_process_and_preserves_other_rule(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(relay.subprocess,'Popen',FakeProcess),patch.object(relay.time,'time',return_value=1000),patch.object(relay.time,'monotonic',return_value=500):
            supervisor=relay.Supervisor('fake',folder)
            r1=self.rule();r2={**r1,'id':'b'*32,'listen_port':31001,'expires_at':1150}
            supervisor.reconcile(dict(server_time=1000,lease_until=1180,relays=[r1,r2]))
            first=supervisor.running[r1['id']]['process'];second=supervisor.running[r2['id']]['process']
            with patch.object(relay.time,'time',return_value=1101),patch.object(relay.time,'monotonic',return_value=601):supervisor.expire()
            self.assertTrue(first.dead);self.assertFalse(second.dead)
            supervisor.close()
    def test_website_disconnect_and_clock_rollback_do_not_extend_monotonic_lease(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(relay.subprocess,'Popen',FakeProcess),patch.object(relay.time,'time',return_value=1000),patch.object(relay.time,'monotonic',return_value=500):
            supervisor=relay.Supervisor('fake',folder);r=self.rule();supervisor.reconcile(dict(server_time=1000,lease_until=1050,relays=[r]));process=supervisor.running[r['id']]['process']
            with patch.object(relay.time,'time',return_value=900),patch.object(relay.time,'monotonic',return_value=551):supervisor.expire()
            self.assertTrue(process.dead)
    def test_new_supervisor_never_restarts_saved_expired_config(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder,'stale.json').write_text('{}')
            self.assertEqual(relay.Supervisor('fake',folder).snapshot(),[])
    def test_malicious_destinations_rejected(self):
        for ip in ['127.0.0.1','169.254.169.254','192.168.0.1','::1','224.0.0.1']:
            with self.assertRaises(ValueError):relay.gost_config({**self.rule(),'target_ip':ip})
            with self.assertRaises(ValueError):worker.validate_connection({'ip':ip,'ssh_port':22})
    def test_shell_input_is_quoted_not_interpolated_as_a_command(self):
        value="p'$(touch /tmp/not-run)\nnext"
        result=worker.assignments({'MSBOOST_VALUE':value})
        import shlex
        self.assertEqual(shlex.split(result)[0], 'MSBOOST_VALUE='+value)

if __name__=='__main__':unittest.main()
