import bz2
import hashlib
from io import BytesIO
import tempfile
import unittest
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError
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
            factory.return_value.open.assert_called_once()

    def test_cn_transport_error_retries_original_http_and_preserves_attempt_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp, patch('cs2demo.download._download_once') as fetch:
            url = 'http://replay237.csgo.com.cn/730/a.dem.bz2?test=private-path-value'
            fetch.side_effect = [DownloadError('download_connection_reset', details={'stage': 'download', 'received_bytes': 123}),
                                 (Path(tmp) / 'replay.dem', {'bytes': 12})]
            _, receipt = download_demo(url, Path(tmp))
            self.assertEqual([call.args[0] for call in fetch.call_args_list], [url, url])
            self.assertEqual([call.kwargs['attempt'] for call in fetch.call_args_list], [1, 2])
            self.assertLessEqual(fetch.call_args_list[1].kwargs['timeout_seconds'], fetch.call_args_list[0].kwargs['timeout_seconds'])
            self.assertNotIn('retried_over_https', receipt)
            self.assertEqual([item['result'] for item in receipt['download_attempts']], ['download_connection_reset', 'ok'])
            self.assertEqual(receipt['download_attempts'][0]['received_bytes'], 123)
            self.assertNotIn('private-path-value', str(receipt))

    def test_tls_fallback_follows_two_connection_failures_and_only_for_valve_origin(self):
        with tempfile.TemporaryDirectory() as tmp, patch('cs2demo.download._download_once') as fetch:
            for host, expected in [('replay1.valve.net', ['http', 'http', 'https']),
                                   ('replay237.csgo.com.cn', ['http', 'http']),
                                   ('replay2.wmsj.cn', ['http', 'http'])]:
                http = f'http://{host}/730/a.dem.bz2'
                fetch.reset_mock()
                fetch.side_effect = [DownloadError('download_connection_reset'), DownloadError('download_socket_timeout'),
                                     (Path(tmp) / 'replay.dem', {'bytes': 12})]
                if len(expected) == 3:
                    _, receipt = download_demo(http, Path(tmp))
                    self.assertTrue(receipt['retried_over_https'])
                else:
                    with self.assertRaisesRegex(DownloadError, 'download_socket_timeout') as caught:
                        download_demo(http, Path(tmp))
                    self.assertEqual(len(caught.exception.details['attempts']), 2)
                self.assertEqual([call.args[0] for call in fetch.call_args_list],
                                 [f'{scheme}://{host}/730/a.dem.bz2' for scheme in expected])

    def test_not_found_invalid_data_and_http_backoff_are_not_retried(self):
        with tempfile.TemporaryDirectory() as tmp, patch('cs2demo.download._download_once') as fetch:
            for error in [DownloadError('http_404'), DownloadError('not_cs2_demo'), DownloadError('url_not_allowed'),
                          DownloadError('http_503', details={'retry_after_seconds': 30})]:
                fetch.reset_mock()
                fetch.side_effect = error
                with self.assertRaisesRegex(DownloadError, error.code):
                    download_demo('http://replay237.csgo.com.cn/730/a.dem.bz2', Path(tmp))
                fetch.assert_called_once()

    def test_official_cdn_missing_object_records_only_code_and_exact_url_fingerprint(self):
        official = 'http://replay237.csgo.com.cn/730/123_unique-replay-path.dem.bz2'
        xml = b'<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Key>private-storage-key</Key></Error>'
        with tempfile.TemporaryDirectory() as tmp, patch('cs2demo.download.build_opener') as factory:
            opener = factory.return_value
            opener.open.side_effect = HTTPError(official, 404, 'Missing object',
                                                {'Content-Length': str(len(xml))}, BytesIO(xml))
            with self.assertRaisesRegex(DownloadError, '^http_404$') as caught:
                download_demo(official, Path(tmp))
        details = caught.exception.details
        self.assertEqual(details['url_fingerprint'], hashlib.sha256(official.encode()).hexdigest()[:16])
        self.assertEqual(details['origin_code'], 'NoSuchKey')
        self.assertEqual(details['attempts'][0]['origin_code'], 'NoSuchKey')
        self.assertEqual(details['attempts'][0]['url_fingerprint'], details['url_fingerprint'])
        self.assertNotIn('unique-replay-path', str(details))
        self.assertNotIn('private-storage-key', str(details))
        opener.open.assert_called_once()

    def test_unknown_unbounded_or_non_official_404_does_not_claim_missing_origin_key(self):
        official = 'http://replay237.csgo.com.cn/730/123_article.dem.bz2'
        custom = 'https://files.example.org/730/123_article.dem.bz2?sig=credential'
        xml = b'<Error><Code>NoSuchKey</Code></Error>'
        evil_xml = b'<!DOCTYPE Error [<!ENTITY name "NoSuchKey">]><Error><Code>&name;</Code></Error>'
        unknown_encoding = b'<?xml version="1.0" encoding="unknown-encoding"?><Error><Code>NoSuchKey</Code></Error>'
        html = b'<html><Code>NoSuchKey</Code></html>'

        class TrackedBody(BytesIO):
            def __init__(self, content):
                super().__init__(content)
                self.requests = []

            def read1(self, count):
                self.requests.append(count)
                return super().read1(count)

        inputs = [
            (official, xml, {}, False),
            (official, xml, {'Content-Length': '2049'}, False),
            (official, xml, {'Content-Length': str(len(xml)), 'Content-Encoding': 'gzip'}, False),
            (official, xml, {'Content-Length': str(len(xml) + 1)}, True),
            (official, evil_xml, {'Content-Length': str(len(evil_xml))}, True),
            (official, unknown_encoding, {'Content-Length': str(len(unknown_encoding))}, True),
            (official, html, {'Content-Length': str(len(html))}, True),
            (custom, xml, {'Content-Length': str(len(xml))}, False),
        ]
        with tempfile.TemporaryDirectory() as tmp, patch('cs2demo.download.build_opener') as factory:
            for url, content, headers, read in inputs:
                with self.subTest(headers=headers, intended_probe=read):
                    stream = TrackedBody(content)
                    factory.return_value.open.side_effect = HTTPError(url, 404, 'Missing', headers, stream)
                    with self.assertRaisesRegex(DownloadError, '^http_404$') as caught:
                        download_demo(url, Path(tmp), extra_hosts=('files.example.org',))
                    self.assertNotIn('origin_code', caught.exception.details)
                    self.assertEqual(stream.requests, [int(headers['Content-Length'])] if read else [])
                    if url == custom:
                        self.assertNotIn('url_fingerprint', caught.exception.details)

    def test_retryable_http_errors_and_truncated_transfers_stay_on_custom_https_origin(self):
        with tempfile.TemporaryDirectory() as tmp, patch('cs2demo.download.build_opener') as factory:
            url = 'https://files.example.org/730/a.dem?auth=signed-private-value'
            raw = MAGIC + b'events'
            opener = factory.return_value

            class Response:
                headers = {'Content-Length': str(len(raw))}
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def geturl(self): return url
                def read(self, _): return b''

            class Truncated(Response):
                def read1(self, _): raise IncompleteRead(raw[:2])

            class UnexpectedPartial(Response):
                status = 206
                def read(self, _): raise AssertionError('must not read unrequested partial response')

            class Complete(Response):
                def __init__(self): self.chunks = iter((raw, b''))
                def read1(self, _): return next(self.chunks)

            for first, result in [(HTTPError(url, 503, 'signed-private-value', {}, None), 'http_503'),
                                  (Truncated(), 'truncated_download'),
                                  (UnexpectedPartial(), 'truncated_download')]:
                opener.open.reset_mock()
                opener.open.side_effect = [first, Complete()]
                target, receipt = download_demo(url, Path(tmp), extra_hosts=('files.example.org',))
                self.assertEqual(target.read_bytes(), raw)
                self.assertEqual([call.args[0].full_url for call in opener.open.call_args_list], [url, url])
                self.assertEqual(receipt['download_attempts'][0]['result'], result)
                self.assertNotIn('signed-private-value', str(receipt))

    def test_shared_time_budget_can_stop_a_retry(self):
        with tempfile.TemporaryDirectory() as tmp, patch('cs2demo.download._download_once') as fetch, \
                patch('cs2demo.download.time.monotonic', side_effect=[100, 100, 160]):
            fetch.side_effect = DownloadError('download_socket_timeout')
            with self.assertRaisesRegex(DownloadError, 'download_socket_timeout'):
                download_demo('http://replay1.valve.net/730/a.dem', Path(tmp), timeout_seconds=60)
            fetch.assert_called_once()

    def test_progress_distinguishes_connect_transfer_decompression_and_validation(self):
        raw = MAGIC + b'event payload'
        payload = bz2.compress(raw)

        class Response:
            headers = {'Content-Length': str(len(payload))}
            def __init__(self): self.chunks = iter((payload[:20], payload[20:], b''))
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def geturl(self): return 'http://replay1.valve.net/730/a.dem.bz2'
            def read(self, _): return next(self.chunks)

        seen = []
        def observe(phase, **fields):
            seen.append((phase, fields))
            if phase == 'decompressing':
                raise RuntimeError('progress publisher unavailable')

        with tempfile.TemporaryDirectory() as tmp, patch('cs2demo.download.build_opener') as factory:
            factory.return_value.open.return_value = Response()
            url = 'http://replay1.valve.net/730/a.dem.bz2'
            target, receipt = download_demo(url, Path(tmp), on_progress=observe)
            self.assertEqual(target.read_bytes(), raw)
            self.assertEqual(receipt['url_fingerprint'], hashlib.sha256(url.encode()).hexdigest()[:16])
        self.assertEqual(seen[0], ('downloading', {'attempt': 1}))
        self.assertIn(('downloading', {'attempt': 1, 'received_bytes': 0, 'total_bytes': len(payload)}), seen)
        self.assertEqual(seen[-3:], [('downloading', {'attempt': 1, 'received_bytes': len(payload), 'total_bytes': len(payload)}),
                                     ('decompressing', {'attempt': 1}), ('validating', {'attempt': 1})])


if __name__ == '__main__': unittest.main()
