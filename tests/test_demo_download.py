import bz2
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from cs2demo.download import DownloadError, MAGIC, materialize_demo, validate_url, download_demo


class DownloadTests(unittest.TestCase):
    def test_only_replay_hosts_or_explicit_https_allowlist(self):
        self.assertEqual(validate_url('http://replay123.valve.net/730/1.dem.bz2'), 'replay123.valve.net')
        self.assertEqual(validate_url('https://replay4.wmsj.cn/730/x'), 'replay4.wmsj.cn')
        self.assertEqual(validate_url('http://replay237.csgo.com.cn/730/a.dem.bz2'), 'replay237.csgo.com.cn')
        self.assertEqual(validate_url('https://files.example.org/a?sig=secret', ('files.example.org',)), 'files.example.org')
        for url in ['file:///etc/passwd', 'http://127.0.0.1/x', 'https://replay1.valve.net.evil.com/x',
                    'http://replay1.valve.net@evil.com/x', 'https://replay1.valve.net:8080/x',
                    'https://localhost/a', 'http://files.example.org/x',
                    'http://replay237.csgo.com.cn.evil.com/730/a.dem.bz2']:
            with self.subTest(url=url), self.assertRaises(DownloadError):
                validate_url(url, ('localhost', 'files.example.org'))

    def test_raw_and_bzip_replays_and_integrity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, target = root/'input', root/'out.dem'
            raw = MAGIC + b'event payload' * 100
            receipts = []
            for payload in [raw, bz2.compress(raw)]:
                source.write_bytes(payload)
                receipts.append(materialize_demo(source, target))
                self.assertEqual(target.read_bytes(), raw)
            self.assertEqual(receipts[0], receipts[1])
            source.write_bytes(bz2.compress(raw)[:-4])
            with self.assertRaises(DownloadError):
                materialize_demo(source, target)
            self.assertFalse(target.exists())

    def test_decompression_size_and_format_limits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, target = root/'input', root/'out.dem'
            source.write_bytes(bz2.compress(MAGIC + b'a' * 1000))
            with self.assertRaisesRegex(DownloadError, 'demo_too_large'):
                materialize_demo(source, target, max_bytes=64)
            source.write_bytes(b'<html>expired replay</html>')
            with self.assertRaisesRegex(DownloadError, 'not_cs2_demo'):
                materialize_demo(source, target)

    def test_downloader_rejects_redirect_destination_before_read(self):
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def geturl(self): return 'http://169.254.169.254/latest/meta-data/'
            def read(self, _): raise AssertionError('must not read disallowed host')
        with tempfile.TemporaryDirectory() as tmp, patch('cs2demo.download.build_opener') as factory:
            factory.return_value.open.return_value = Response()
            with self.assertRaisesRegex(DownloadError, 'url_not_allowed'):
                download_demo('http://replay1.valve.net/a', Path(tmp))

    def test_transport_failure_can_retry_same_replay_over_verified_https(self):
        with tempfile.TemporaryDirectory() as tmp, patch('cs2demo.download._download_once') as fetch:
            fetch.side_effect=[DownloadError('download_connection_reset'),(Path(tmp)/'replay.dem',{'bytes':12})]
            _,receipt=download_demo('http://replay237.csgo.com.cn/730/a.dem.bz2',Path(tmp))
            self.assertEqual(fetch.call_args_list[1].args[0],'https://replay237.csgo.com.cn/730/a.dem.bz2')
            self.assertTrue(receipt['retried_over_https'])
            self.assertLessEqual(fetch.call_args_list[1].kwargs['timeout_seconds'],900)
            fetch.reset_mock()
            fetch.side_effect=DownloadError('http_404')
            with self.assertRaisesRegex(DownloadError,'http_404'):
                download_demo('http://replay237.csgo.com.cn/730/a.dem.bz2',Path(tmp))
            self.assertEqual(fetch.call_count,1)


if __name__ == '__main__': unittest.main()
