#!/usr/bin/env python3
"""Dev-сервер фронта: отдаёт статику web/ и проксирует /api/* и /healthz на бэкенд.

Фронт и API оказываются на одном origin, поэтому бэкенду не нужен CORS.
Если бэкенд не запущен, /api отвечает 502 с кодом backend_unavailable —
фронт в режиме auto тогда переключается на заглушку.

    python3 dev_server.py                      # http://localhost:8000, бэкенд на :8080
    python3 dev_server.py --port 3000 --backend http://localhost:9090
"""
import argparse
import http.server
import json
import os
import urllib.error
import urllib.request

PROXY_PREFIXES = ('/api/', '/healthz')
FORWARD_REQUEST_HEADERS = ('Content-Type', 'Accept', 'Authorization', 'Last-Event-ID')
# Hop-by-hop заголовки и длина: тело пересылаем сами
SKIP_RESPONSE_HEADERS = {'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'server', 'date'}


class Handler(http.server.SimpleHTTPRequestHandler):
    backend = 'http://localhost:8080'

    def is_api(self):
        return self.path.startswith(PROXY_PREFIXES)

    def do_GET(self):
        if self.is_api():
            self.proxy()
        else:
            super().do_GET()

    def do_HEAD(self):
        if self.is_api():
            self.proxy()
        else:
            super().do_HEAD()

    def do_POST(self):
        self.proxy_or_405()

    def do_PUT(self):
        self.proxy_or_405()

    def do_PATCH(self):
        self.proxy_or_405()

    def do_DELETE(self):
        self.proxy_or_405()

    def proxy_or_405(self):
        if self.is_api():
            self.proxy()
        else:
            self.send_error(405)

    def end_headers(self):
        # ES-модули без сборки: браузер не должен держать старые версии
        if not self.is_api():
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def proxy(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        upstream = urllib.request.Request(self.backend + self.path, data=body, method=self.command)
        for name in FORWARD_REQUEST_HEADERS:
            if self.headers.get(name):
                upstream.add_header(name, self.headers[name])

        streaming = self.path.startswith('/api/stream')
        try:
            # Поток SSE может долго молчать — без тайм-аута на чтение
            response = urllib.request.urlopen(upstream, timeout=None if streaming else 60)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, OSError) as error:
            self.log_message('backend unavailable: %s', error)
            payload = {'error': {'code': 'backend_unavailable', 'message': 'Бэкенд не запущен'}}
            self.send_json(502, payload)
            return

        with response:
            self.send_response(response.status)
            for name, value in response.headers.items():
                if name.lower() not in SKIP_RESPONSE_HEADERS:
                    self.send_header(name, value)
            is_stream = 'text/event-stream' in (response.headers.get('Content-Type') or '')
            if is_stream:
                self.end_headers()
                try:
                    while chunk := response.read1(65536):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # вкладку закрыли
                return
            data = response.read()
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(data)

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8000)))
    parser.add_argument('--backend', default=os.environ.get('BACKEND_URL', 'http://localhost:8080'))
    args = parser.parse_args()

    Handler.backend = args.backend.rstrip('/')
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Фронт: http://localhost:{args.port}  →  API: {Handler.backend}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
