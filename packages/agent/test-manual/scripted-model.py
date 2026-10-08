"""Deterministic local OpenAI-compatible SSE fixture. Never calls an external LLM."""
import argparse, json, re, time, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REQUEST_LOG = None
lock = threading.Lock()

def text_of(m):
    content = m.get('content') or ''
    if isinstance(content, str): return content
    return '\n'.join(c.get('text','') for c in content if isinstance(c,dict))

def response_for(body):
    messages = body.get('messages', [])
    users = [(i,text_of(m)) for i,m in enumerate(messages) if m.get('role')=='user']
    last_i, prompt = users[-1] if users else (-1,'')
    # The latest unfinished command may precede a steered input.
    start = last_i
    while start > 0 and messages[start-1].get('role') == 'user': start -= 1
    prompts = '\n'.join(text_of(m) for m in messages[start:] if m.get('role')=='user')
    tools_after = [m for m in messages[start:] if m.get('role')=='tool']
    if 'FIXTURE-ORPHAN' in prompts and not tools_after:
        return None, ('bash', {'command':'printf "%s" "$$" > tool.pid; sleep 5; printf orphan-finished > orphan.txt'})
    if 'FIXTURE-SLOW' in prompts and not tools_after:
        return None, ('bash', {'command':'sleep 5; printf fixture-slow-done'})
    if 'FIXTURE-CRASH' in prompts and not tools_after:
        return None, ('bash', {'command':'sleep 8; printf crash-done > crash.txt'})
    if 'FIXTURE-ISOLATION' in prompts and not tools_after:
        return None, ('bash', {'command':"cat ../victim/secret.txt; printf escaped > ../../outside-proof.txt"})
    if 'FIXTURE-WRITE' in prompts and not tools_after:
        return None, ('bash', {'command':'printf fixture-file > proof.txt'})
    if 'FIXTURE-ROUTE' in prompts and not tools_after:
        match = re.search(r'FIXTURE-ROUTE\s+(\S+)\s+(.+)', prompts)
        return None, ('send_message',{'target':match[1],'text':match[2].split('\n')[0]})
    if 'send_message tool exactly once' in prompts and not tools_after:
        target = re.search(r'target "([^"]+)"',prompts)
        text = re.search(r'text "([^"]+)"',prompts)
        return None, ('send_message',{'target':target[1],'text':text[1]})
    if 'bash tool' in prompts and not tools_after:
        command = re.search(r'`([^`]+)`',prompts)
        if command: return None, ('bash',{'command':command[1]})
    if 'CRASH-TEST-DONE' in prompts: return 'CRASH-TEST-DONE', None
    if 'FILE-DONE' in prompts: return 'FILE-DONE', None
    if 'KUMQUAT' in prompts: return 'BASE KUMQUAT', None
    for marker in ['PONG','READY']:
        if f'"{marker}"' in prompts: return marker, None
    if 'Say ONE' in prompts: return 'ONE', None
    if 'Say TWO' in prompts: return 'TWO', None
    if 'FIXTURE-' in prompts: return 'FIXTURE-DONE ' + prompt.split('\n')[0], None
    if 'summar' in prompts.lower() or 'compac' in prompts.lower(): return 'Local fixture summary: continue the requested task.', None
    return 'DONE', None

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self,*args): pass
    def do_GET(self):
        data=b'{"fixture":"scripted-local-model"}'
        self.send_response(200); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
        answer, tool = response_for(body)
        if REQUEST_LOG is not None:
            with lock:
                with REQUEST_LOG.open('a') as f:
                    f.write(json.dumps({'at':time.time(),'path':self.path,'body':body,'fixtureText':answer,'fixtureTool':tool})+'\n')
        if any('FIXTURE-MODEL-ERROR' in text_of(m) for m in body.get('messages',[]) if m.get('role')=='user'):
            data=b'{"error":{"message":"fixture simulated provider unavailable","type":"server_error"}}'
            self.send_response(503); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data); return
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.send_header('Connection','close'); self.end_headers()
        ident='chatcmpl-fixture-'+uuid.uuid4().hex
        def chunk(delta,reason=None):
            obj={'id':ident,'object':'chat.completion.chunk','created':int(time.time()),'model':body.get('model'),'choices':[{'index':0,'delta':delta,'finish_reason':reason}]}
            self.wfile.write(('data: '+json.dumps(obj)+'\n\n').encode()); self.wfile.flush()
        try:
            chunk({'role':'assistant','content':''})
            if tool:
                chunk({'tool_calls':[{'index':0,'id':'call_'+uuid.uuid4().hex,'type':'function','function':{'name':tool[0],'arguments':json.dumps(tool[1])}}]})
                chunk({},'tool_calls')
            else:
                chunk({'content':answer}); chunk({},'stop')
            usage={'id':ident,'object':'chat.completion.chunk','choices':[],'usage':{'prompt_tokens':12,'completion_tokens':4,'total_tokens':16}}
            self.wfile.write(('data: '+json.dumps(usage)+'\n\ndata: [DONE]\n\n').encode()); self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError): pass
        self.close_connection=True

if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--log', type=Path)
    args = parser.parse_args()
    REQUEST_LOG = args.log
    if REQUEST_LOG is not None:
        REQUEST_LOG.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(json.dumps({'fixture':'scripted-local-model','url':f'http://127.0.0.1:{server.server_port}/v1'}), flush=True)
    server.serve_forever()
