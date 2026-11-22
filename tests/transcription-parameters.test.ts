import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, writeFile, chmod, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os'; import path from 'node:path';
import {transcribeRemote,transcribeWithWhisperCpp,transcribeWithPythonWhisper,transcribeWithFasterWhisper,transcribeWithMlxWhisper} from '../electron/services/providers.mjs';
const directories:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();await Promise.all(directories.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
describe('actual transcription parameter dispatch',()=>{
  it('includes temperature=0 and prompt in multipart requests',async()=>{
    let form:FormData;
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{form=init.body;return new Response(JSON.stringify({text:'test'}),{headers:{'content-type':'application/json'}})}));
    const profile={transport:'openai-audio',model:'whisper-1',baseUrl:'https://example.com/v1',options:{temperature:0,initialPrompt:'项目会议'}};
    await transcribeRemote(profile,'',Buffer.alloc(10),'test.wav','en',['协议'],undefined,'上一段文字。');
    expect(form!.get('temperature')).toBe('0');expect(form!.get('prompt')).toBe('项目会议 上一段文字。 协议');
    await transcribeRemote({...profile,options:{...profile.options,usePreviousText:false}},'',Buffer.alloc(10),'test.wav','en',['协议'],undefined,'上一段文字。');
    expect(form!.get('prompt')).toBe('项目会议 协议');
  });
  it('passes official CLI flags with their values to an executable',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'mf-cli-params-'));directories.push(dir);
    const exe=path.join(dir,'whisper');const log=path.join(dir,'args.json');
    await writeFile(exe,`#!/usr/bin/env python3\nimport sys,json\na=sys.argv[1:]\nopen(${JSON.stringify(log)},'w').write(json.dumps(a))\njson.dump({'transcription':[{'offsets':{'from':0,'to':1000},'text':'test'}]},open(a[a.index('-of')+1]+'.json','w'))\n`);await chmod(exe,0o755);
    await transcribeWithWhisperCpp({transport:'whisper-cpp',options:{modelPath:'/test.bin',executablePath:exe,computeMode:'cpu',temperature:0,temperatureStep:.2,beamSize:5,bestOf:2,cpuThreads:3,noSpeechThreshold:.6,logprobThreshold:-1,entropyThreshold:2.4,initialPrompt:'项目会议'}},Buffer.alloc(20),'test.wav','zh');
    const args=JSON.parse(await readFile(log,'utf8'));expect(args).toContain('--entropy-thold');expect(args[args.indexOf('--beam-size')+1]).toBe('5');expect(args[args.indexOf('--prompt')+1]).toContain('项目会议');
    expect(args).toContain('--no-gpu');
    expect(args[args.indexOf('--best-of')+1]).toBe('2');
    expect(args[args.indexOf('--threads')+1]).toBe('3');
  });
  it('runs Python, faster and MLX scripts with supported JSON options only',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'mf-python-params-'));directories.push(dir);vi.stubEnv('PYTHONPATH',dir);
    await writeFile(path.join(dir,'whisper.py'),`import json\nclass Model:\n def transcribe(self,audio,**options): return {'text':json.dumps(options),'segments':[]}\ndef load_model(path): return Model()\n`);
    await writeFile(path.join(dir,'faster_whisper.py'),`import json\nfrom types import SimpleNamespace\nclass WhisperModel:\n def __init__(self,*args,**kwargs): pass\n def transcribe(self,audio,**options): return [SimpleNamespace(start=0,end=1,text=json.dumps(options))],SimpleNamespace(language='en')\n`);
    await writeFile(path.join(dir,'mlx_whisper.py'),`import json\ndef transcribe(audio,**options): return {'text':json.dumps(options),'segments':[]}\n`);
    // MLX-Whisper 只在 Apple Silicon macOS 上可用（providers.mjs 守卫同时检查
    // platform 与 arch），Intel Mac 上必须跳过，否则 npm test 必红。
    const engines=[['whisper-python',transcribeWithPythonWhisper],['faster-whisper',transcribeWithFasterWhisper],...(process.platform==='darwin'&&process.arch==='arm64'?[['mlx-whisper',transcribeWithMlxWhisper]]:[])] as const;
    for(const [transport,run] of engines){
      const result=await run({transport,options:{modelPath:'/test.pt',pythonExecutablePath:'python3',temperature:0,temperatureStep:.2,beamSize:5,bestOf:3,noSpeechThreshold:.6,logprobThreshold:-1,compressionRatioThreshold:2.4,vadFilter:false,initialPrompt:'项目会议'}},Buffer.alloc(20),'test.wav','en');
      const options=JSON.parse(result.text);expect(options.initial_prompt).toBe('项目会议');
      expect(options.temperature).toEqual([0,.2,.4,.6,.8,1]);
      expect(options.best_of).toBe(3);
      expect(options.no_speech_threshold).toBe(0.6);
      expect(options.compression_ratio_threshold).toBe(2.4);
      if(transport==='faster-whisper') {
        expect(options.log_prob_threshold).toBe(-1);
        expect(options.logprob_threshold).toBeUndefined();
        expect(options.vad_filter).toBe(false);
      } else {
        expect(options.logprob_threshold).toBe(-1);
        expect(options.vad_filter).toBeUndefined();
      }
      if(transport==='mlx-whisper') expect(options.beam_size).toBeUndefined();else expect(options.beam_size).toBe(5);
    }
  });
});
