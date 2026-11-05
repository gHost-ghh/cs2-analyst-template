from datetime import datetime, timedelta, timezone
import json
import os
import subprocess
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from cs2demo.download import MAGIC
from cs2demo.advanced import ANALYSIS_VERSION
from cs2demo.pipeline import enqueue, ensure_account, load_state, run_pipeline, due, mark_failure, parse_bounded, discover_recent_codes
from cs2demo.download import DownloadError

SID = '76561198096123254'
CODE = 'CSGO-CQNLr-6sp23-JwjmS-kQPwR-tm7SA'


def fake_parse(path, steamid):
    return {'schema_version':'1.0', 'player':{'steamid':steamid}, 'map_name':'de_test',
            'rounds':[{'round_number':1, 'side':'CT', 'kills':1, 'deaths':0, 'assists':0,
                       'damage':100, 'headshot_kills':1, 'opening_kill':True, 'opening_death':False,
                       'survived':True, 'traded':False, 'kast':True}],
            'summary':{'rounds':1,'kills':1,'deaths':0,'assists':0,'damage':100},
            'provenance':{}, 'limitations':['synthetic fixture']}


class PipelineTests(unittest.TestCase):
    def test_bounded_retry_sweep_visits_every_job_once_and_passes_download_deadline(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'STEAM_REFRESH_TOKEN': 'fake'}, clear=True):
            root = Path(tmp)
            ensure_account(root / 'data', SID)
            state = load_state(root / 'data', SID)
            answers = {}
            for index in range(14):
                code = f'CSGO-{index:05d}-6sp23-JwjmS-kQPwR-tm7SA'
                job = enqueue(state, code)
                job.update(status='retry', attempts=1, next_attempt_at='2099-01-01T00:00:00Z')
                answers[code] = {'status': 'resolved', 'url': 'https://replay1.valve.net/730/a.dem'}
            (root / 'data/demo_jobs.json').write_text(json.dumps(state))
            with patch('cs2demo.pipeline.resolve_codes', return_value=answers), \
                 patch('cs2demo.pipeline.download_demo', side_effect=DownloadError('http_404')) as download:
                result = run_pipeline(root, SID, limit=20, force=True, download_timeout_seconds=300)
            self.assertEqual(download.call_count, 14)
            self.assertTrue(all(call.kwargs['timeout_seconds'] == 300 for call in download.call_args_list))
            saved = json.loads((root / 'data/demo_jobs.json').read_text())
            self.assertTrue(all(job['attempts'] == 2 for job in saved['jobs'].values()))
            self.assertEqual(result['status_counts']['unavailable'], 14)

    def setUp(self):
        mocked=patch('cs2demo.pipeline.discover_recent_codes',return_value={'status':'discovered'})
        mocked.start()
        self.addCleanup(mocked.stop)

    def test_queue_preserves_completion_and_rejects_cross_account(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp)
            ensure_account(data,SID)
            state=load_state(data,SID)
            job=enqueue(state,CODE)
            job['status']='complete'
            self.assertEqual(enqueue(state,CODE)['status'],'complete')
            with self.assertRaisesRegex(RuntimeError,'account_mismatch'):
                ensure_account(data,'76561198000000001')
            with self.assertRaisesRegex(RuntimeError,'invalid_share_code'):
                enqueue(state,'not-a-sharecode')

    def test_retry_backoff_and_force(self):
        current=datetime(2026,10,15,tzinfo=timezone.utc)
        job={'status':'retry','attempts':3}
        mark_failure(job,'http_404',current)
        self.assertFalse(due(job,current+timedelta(hours=1)))
        self.assertTrue(due(job,current+timedelta(hours=1),True))
        self.assertTrue(due(job,current+timedelta(hours=8)))
        job['status']='complete'
        self.assertFalse(due(job,current,True))

    def test_analysis_upgrade_failure_preserves_validated_match_and_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{},clear=True):
            root=Path(tmp)
            replay=root/'input.dem'
            replay.write_bytes(MAGIC+b'fixture')
            run_pipeline(root,SID,code=CODE,local_demo=replay,parser=fake_parse)
            state_path=root/'data/demo_jobs.json'
            state=json.loads(state_path.read_text())
            job=next(iter(state['jobs'].values()))
            job['source']='steam_gc'
            result_path=root/'data'/job['result_path']
            original=result_path.read_bytes()
            state_path.write_text(json.dumps(state))
            with patch.dict(os.environ,{'STEAM_REFRESH_TOKEN':'fake'}), \
                 patch('cs2demo.pipeline.resolve_codes',return_value={CODE:{'status':'unavailable','error_code':'http_404'}}):
                snapshot=run_pipeline(root,SID,upgrade_analysis=True)
            saved=json.loads(state_path.read_text())['jobs'][job['id']]
            self.assertEqual(saved['status'],'complete')
            self.assertEqual(saved['upgrade_last_error_code'],'http_404')
            self.assertEqual(result_path.read_bytes(),original)
            self.assertEqual(snapshot['matches_analyzed'],1)
            from cs2demo.shards import load_dashboard
            dashboard=load_dashboard(root/'reports')
            self.assertEqual(dashboard['sync']['run_outcome'],'failed')

    def test_analysis_upgrade_is_versioned_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{},clear=True):
            root=Path(tmp)
            replay=root/'input.dem'
            replay.write_bytes(MAGIC+b'fixture')
            run_pipeline(root,SID,code=CODE,local_demo=replay,parser=fake_parse)
            state_path=root/'data/demo_jobs.json'
            state=json.loads(state_path.read_text())
            job=next(iter(state['jobs'].values()))
            job['source']='steam_gc'
            state_path.write_text(json.dumps(state))
            def download(url,directory,**kwargs):
                path=directory/'replay.dem'; path.write_bytes(MAGIC+b'fixture')
                return path,{'sha256':'fixture'}
            def upgraded(path,steamid):
                result=fake_parse(path,steamid); result['analysis_version']=ANALYSIS_VERSION; return result
            answer={CODE:{'status':'resolved','url':'https://replay1.valve.net/730/x.dem'}}
            with patch.dict(os.environ,{'STEAM_REFRESH_TOKEN':'fake'}), \
                 patch('cs2demo.pipeline.resolve_codes',return_value=answer) as resolver, \
                 patch('cs2demo.pipeline.download_demo',side_effect=download):
                first=run_pipeline(root,SID,upgrade_analysis=True,parser=upgraded)
                self.assertEqual(len(resolver.call_args.args[0]),1)
                second=run_pipeline(root,SID,upgrade_analysis=True,parser=lambda *args:self.fail('already upgraded'))
                self.assertEqual(resolver.call_args.args[0],[])
            self.assertEqual(first['matches_analyzed'],1)
            self.assertEqual(second['run_outcome'],'idle')

    def test_no_token_is_visible_and_leaves_code_for_later(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{},clear=True):
            root=Path(tmp)
            ensure_account(root/'data',SID)
            (root/'data'/'official_codes.json').write_text(json.dumps({'codes':[CODE]}))
            with patch('cs2demo.pipeline.resolve_codes') as resolver:
                snapshot=run_pipeline(root,SID)
                self.assertEqual(resolver.call_args.args[0],[])
            self.assertEqual(snapshot['status_counts']['blocked_auth'],1)
            state=json.loads((root/'data'/'demo_jobs.json').read_text())
            self.assertEqual(next(iter(state['jobs'].values()))['last_error_code'],'steam_refresh_token_missing')
            self.assertFalse((root/'data'/'demo_matches').exists())

    def test_parse_success_idempotent_and_no_demo_committed(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{},clear=True):
            root=Path(tmp)
            replay=root/'input.dem'
            replay.write_bytes(MAGIC+b'fake but valid header')
            first=run_pipeline(root,SID,code=CODE,local_demo=replay,parser=fake_parse)
            self.assertEqual(first['matches_analyzed'],1)
            def no_parse(*args): raise AssertionError('complete job must not run again')
            second=run_pipeline(root,SID,code=CODE,local_demo=replay,parser=no_parse,force=True)
            self.assertEqual(second['matches_analyzed'],1)
            self.assertEqual(len(list((root/'data'/'demo_matches').glob('*.json'))),1)
            saved=json.loads(next((root/'data'/'demo_matches').glob('*.json')).read_text())
            self.assertEqual(saved['share_code'],CODE)
            self.assertIn('sha256',saved['provenance'])
            self.assertEqual(list((root/'data').rglob('*.dem')),[])

    def test_bad_demo_is_retriable_without_result_and_error_is_redacted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            replay=root/'bad.dem'
            replay.write_bytes(MAGIC+b'broken payload')
            def fail(*args): raise ValueError('secret-input-url?key=must-not-be-logged')
            run_pipeline(root,SID,code=CODE,local_demo=replay,parser=fail)
            state=(root/'data'/'demo_jobs.json').read_text()
            self.assertNotIn('must-not-be-logged',state)
            self.assertEqual(next(iter(json.loads(state)['jobs'].values()))['status'],'retry')
            self.assertTrue(next(iter(json.loads(state)['jobs'].values()))['download_completed_before'])

    def test_direct_url_overrides_previous_missing_token_backoff(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{},clear=True):
            root=Path(tmp)
            run_pipeline(root,SID,code=CODE)
            state_path=root/'data'/'demo_jobs.json'
            state=json.loads(state_path.read_text())
            next(iter(state['jobs'].values())).update({
                'match_started_at':'2026-10-14T12:00:00Z',
                'timestamp_provenance':'Steam GC matchList.matchtime'})
            state_path.write_text(json.dumps(state))
            def download(url,directory,**kwargs):
                demo=directory/'replay.dem'
                demo.write_bytes(MAGIC+b'fixture')
                return demo, {'sha256':'fixture'}
            with patch('cs2demo.pipeline.download_demo',side_effect=download):
                result=run_pipeline(root,SID,code=CODE,url='https://replay1.valve.net/demo?private=redact',parser=fake_parse)
            self.assertEqual(result['matches_analyzed'],1)
            self.assertNotIn('private=redact',(root/'data'/'demo_jobs.json').read_text())
            self.assertEqual(result['chronology']['basis'],'parse_order')

    def test_new_token_restores_queued_jobs_and_retains_verified_gc_time(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{},clear=True):
            root=Path(tmp)
            run_pipeline(root,SID,code=CODE)
            answer={CODE:{'share_code':CODE, 'status':'resolved', 'url':'http://replay1.valve.net/730/a.dem',
                          'match_time_verified':True, 'match_started_at':'2026-10-14T12:00:00Z'}}
            def download(url,directory,**kwargs):
                demo=directory/'replay.dem'
                demo.write_bytes(MAGIC+b'fixture')
                return demo, {'sha256':'fixture'}
            with patch.dict(os.environ,{'STEAM_REFRESH_TOKEN':'not-a-real-token'}), \
                 patch('cs2demo.pipeline.resolve_codes',return_value=answer) as resolver, \
                 patch('cs2demo.pipeline.download_demo',side_effect=download):
                result=run_pipeline(root,SID,parser=fake_parse)
            self.assertEqual(len(resolver.call_args.args[0]),1)
            self.assertEqual(result['matches_analyzed'],1)
            self.assertEqual(result['chronology']['basis'],'verified_match_time')
            self.assertEqual(result['run_outcome'],'ok')

    def test_explicit_code_retries_immediately_and_auth_errors_are_actionable(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{},clear=True):
            root=Path(tmp)
            run_pipeline(root,SID,code=CODE)
            answer={CODE:{'status':'unavailable','error_code':'STEAM_ACCOUNT_MISMATCH'}}
            with patch.dict(os.environ,{'STEAM_REFRESH_TOKEN':'not-a-real-token'}), \
                 patch('cs2demo.pipeline.resolve_codes',return_value=answer):
                result=run_pipeline(root,SID,code=CODE)
            self.assertEqual(result['status_counts']['blocked_auth'],1)
            state=json.loads((root/'data'/'demo_jobs.json').read_text())
            job=next(iter(state['jobs'].values()))
            self.assertEqual(job['attempts'],2)
            self.assertEqual(job['last_error_code'],'steam_account_mismatch')
            self.assertEqual(result['run_outcome'],'blocked_auth')
            # A later run inside backoff must keep signaling manual action.
            with patch.dict(os.environ,{'STEAM_REFRESH_TOKEN':'not-a-real-token'}):
                later=run_pipeline(root,SID)
            self.assertEqual(later['run_outcome'],'blocked_auth')

    def test_parser_subprocess_timeout_is_sanitized_and_credentials_removed(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch.dict(os.environ,{'STEAM_REFRESH_TOKEN':'secret','STEAM_WEB_API_KEY':'secret','LEETIFY_API_KEY':'secret'}), \
             patch('cs2demo.pipeline.subprocess.run',side_effect=subprocess.TimeoutExpired('private-input',240)) as run:
            with self.assertRaisesRegex(DownloadError,'parser_timeout'):
                parse_bounded(Path(tmp)/'replay.dem',SID)
            child_env=run.call_args.kwargs['env']
            self.assertNotIn('STEAM_REFRESH_TOKEN',child_env)
            self.assertNotIn('STEAM_WEB_API_KEY',child_env)
            self.assertNotIn('LEETIFY_API_KEY',child_env)

    def test_parser_failure_reports_safe_stage_without_private_exception_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            def run(args,**kwargs):
                Path(args[-1]).write_text(json.dumps({'error_code':'parser_event_schema','error_stage':'events'}))
                return SimpleNamespace(returncode=1,stderr=b'unsafe upstream detail')
            with patch('cs2demo.pipeline.subprocess.run',side_effect=run):
                with self.assertRaisesRegex(DownloadError,'^parser_event_schema_events$'):
                    parse_bounded(Path(tmp)/'replay.dem',SID)

    def test_missing_replay_is_waiting_for_file_not_a_false_parse_success(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'STEAM_REFRESH_TOKEN':'fake'},clear=True), \
             patch('cs2demo.pipeline.resolve_codes',return_value={CODE:{'status':'unavailable','error_code':'REPLAY_URL_UNAVAILABLE'}}):
            result=run_pipeline(Path(tmp),SID,code=CODE)
            self.assertEqual(result['run_outcome'],'waiting_for_replays')
            self.assertEqual(result['matches_analyzed'],0)
            self.assertEqual(result['status_counts']['unavailable'],1)

    def test_recent_discovery_failure_is_not_hidden_by_idle_queue(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'STEAM_REFRESH_TOKEN':'fake'},clear=True), \
             patch('cs2demo.pipeline.discover_recent_codes',return_value={'status':'expired','error_code':'steam_refresh_token_expired'}):
            result=run_pipeline(Path(tmp),SID)
            self.assertEqual(result['run_outcome'],'blocked_auth')

    def test_forced_bootstrap_prioritizes_newest_gc_match_over_old_unattempted_jobs(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'STEAM_REFRESH_TOKEN':'fake'},clear=True):
            def discovery(data,state):
                latest=enqueue(state,CODE)
                latest.update({'last_attempt_at':'2026-10-15T05:00:00Z','discovered_match_started_at':'2026-10-10T00:00:00Z'})
                older=enqueue(state,'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK')
                older['discovered_match_started_at']='2026-10-09T00:00:00Z'
                return {'status':'discovered'}
            with patch('cs2demo.pipeline.discover_recent_codes',side_effect=discovery), \
                 patch('cs2demo.pipeline.resolve_codes',return_value={}) as resolver:
                run_pipeline(Path(tmp),SID,limit=1,force=True)
            self.assertEqual(resolver.call_args.args[0][0]['share_code'],CODE)


class DiscoveryTests(unittest.TestCase):
    def test_recent_matches_are_queued_without_urls_and_duplicate_codes_are_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp)
            state={'schema_version':1,'steamid64':SID,'jobs':{}}
            def fake_run(args,**kwargs):
                Path(args[-1]).write_text(json.dumps({'status':'discovered','matches':[{'share_code':CODE}],
                    'unencodable_matches':[{'match_id':'123'}], 'ignored_url':'http://secret.invalid/private'}))
            with patch('cs2demo.pipeline.subprocess.run',side_effect=fake_run):
                first=discover_recent_codes(data,state)
                second=discover_recent_codes(data,state)
            self.assertEqual(first['newly_queued'],1)
            self.assertEqual(second['newly_queued'],0)
            self.assertEqual(first['unencodable_matches'],1)
            self.assertNotIn('secret.invalid',(data/'gc_discovery.json').read_text())
            self.assertEqual(len(state['jobs']),1)

    def test_bad_discovery_output_saves_safe_failure(self):
        with tempfile.TemporaryDirectory() as tmp, \
             patch('cs2demo.pipeline.subprocess.run',side_effect=subprocess.TimeoutExpired('secret',140)):
            result=discover_recent_codes(Path(tmp),{'schema_version':1,'steamid64':SID,'jobs':{}})
            self.assertEqual(result['status'],'transient')
            self.assertEqual(result['error_code'],'gc_discovery_failed')


if __name__ == '__main__': unittest.main()
