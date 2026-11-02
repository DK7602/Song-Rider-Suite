// Vocal Auto-Tune: YIN pitch tracking plus a pitch-synchronous delay-line shifter.
//
// The tuned voice is read from a ring buffer by one head whose delay drifts as the pitch is shifted. When the
// head reaches the edge of its window it jumps back by a whole number of the singer's pitch periods (refined by
// matching the waveform), and the old and new heads crossfade over about two periods. Because both heads are in
// step, nothing cancels in the crossfade: no comb filtering or "phasing", which a fixed-size two-head shifter
// (and mixing in the untuned voice at another delay) produces. The amount sets how far and how fast notes are
// pulled to the scale; at any amount the output is the shifted voice only.
//
// Latency is constant on average: the head is kept around minDelay + delayRange / 2 (it re-centres during
// pauses), the same delay as the bypass path, so a live amount change never shifts timing. parts.js passes
// minDelay/delayRange and compensates that latency when it schedules vocal clips. The amount and scale are
// also passed at construction: an offline render (WAV export) can finish before port messages arrive.
//
// process() allocates nothing. Pitch detection only runs while the amount is above 0. After parts.js sends
// {type:'release'} (its chain was torn down), the processor returns false once its input is gone.
const LN2_OVER_12=Math.LN2/12;
// Correction may not move faster than this many semitones per second (avoids abrupt read-rate jumps).
const MAX_SEMITONES_PER_SECOND=160;

class CRPVocalAutotuneProcessor extends AudioWorkletProcessor {
  constructor(options){
    super();
    const o=options?.processorOptions||{};
    this.minDelay=Number(o.minDelay)>0?Number(o.minDelay):384;
    this.delayRange=Number(o.delayRange)>0?Number(o.delayRange):1792;
    this.center=this.minDelay+this.delayRange*.5;
    this.maxDelay=this.minDelay+this.delayRange;
    this.amount=0;
    this.allowed=new Uint8Array(12);
    this.allowedCount=0;
    this.released=false;
    this.settings(o);

    this.ringSize=32768;
    this.writeIndex=0;
    const channels=Math.max(1,Number(options?.outputChannelCount?.[0])||1);
    this.buffers=Array.from({length:channels},()=>new Float32Array(this.ringSize));

    // Pitch tracker (YIN on a 2:1 decimated frame, every 512 samples).
    this.frameSize=2048;
    this.downsample=2;
    this.analysisSize=this.frameSize/this.downsample;
    this.analysis=new Float32Array(this.analysisSize);
    this.diff=new Float32Array(512);
    this.cmnd=new Float32Array(512);
    this.detectEvery=512;
    this.detectCounter=0;
    this.pitchFreq=0;
    this.period=0; // input pitch period in samples while voiced
    this.history=new Float32Array(5);
    this.historyCount=0;
    this.historyPos=0;
    this.sorted=new Float32Array(5);
    this.targetMidi=NaN;
    this.nearestMidi=0;
    this.nearestDist=0;

    // Shifter state: semi is the current shift in semitones, targetSemi what the tracker asks for.
    this.semi=0;
    this.targetSemi=0;
    this.voiced=false;
    this.maxSemiStep=MAX_SEMITONES_PER_SECOND/sampleRate;
    this.d=this.center;     // read-head delay (samples)
    this.oldD=0;            // the previous head, while crossfading
    this.xLen=0;            // crossfade length (0 = none)
    this.xPos=0;
    this.env=0;             // input level follower (for re-centring during pauses)
    this.envDecay=Math.exp(-1/(.05*sampleRate));
    this.engaged=false;     // shifting (or settling back to the bypass delay)

    this.port.onmessage=e=>{
      const d=e.data||{};
      if(d.type==='release'){this.released=true;return;}
      this.settings(d);
    };
  }

  settings(d){
    if(Number.isFinite(Number(d.amount)))this.amount=Math.max(0,Math.min(100,Number(d.amount)));
    if(Array.isArray(d.allowedPcs)){
      this.allowed.fill(0);
      for(const n of d.allowedPcs){const pc=((Math.round(Number(n))%12)+12)%12;if(Number.isFinite(pc))this.allowed[pc]=1;}
      this.allowedCount=this.allowed.reduce((a,b)=>a+b,0);
    }
  }

  sample(buf,pos){
    const n=this.ringSize;
    while(pos<0)pos+=n;
    while(pos>=n)pos-=n;
    const i0=Math.floor(pos),i1=(i0+1)%n,f=pos-i0;
    return buf[i0]*(1-f)+buf[i1]*f;
  }

  // Median of the last `count` tracked pitches (insertion sort into a preallocated scratch array).
  medianMidi(count){
    const n=Math.min(count,this.historyCount),len=this.history.length;
    for(let k=0;k<n;k++){
      const v=this.history[(this.historyPos-1-k+len)%len];
      let j=k;
      while(j>0&&this.sorted[j-1]>v){this.sorted[j]=this.sorted[j-1];j--;}
      this.sorted[j]=v;
    }
    const m=n>>1;
    return n&1?this.sorted[m]:(this.sorted[m-1]+this.sorted[m])*.5;
  }

  // YIN over the most recent frame of channel 0. Sets this.pitchFreq (0 = none).
  detectPitch(buf){
    this.pitchFreq=0;
    const N=this.analysisSize,ds=this.downsample,sr=sampleRate/ds;
    const start=this.writeIndex-this.frameSize;
    let mean=0;
    for(let i=0;i<N;i++){
      let v=0;
      for(let k=0;k<ds;k++)v+=this.sample(buf,start+i*ds+k);
      v/=ds;
      this.analysis[i]=v;
      mean+=v;
    }
    mean/=N;
    let power=0;
    for(let i=0;i<N;i++){
      const v=this.analysis[i]-mean;
      this.analysis[i]=v;
      power+=v*v;
    }
    if(Math.sqrt(power/N)<0.006)return;

    const minLag=Math.max(2,Math.floor(sr/1400)); // up to ~F6 (soprano top)
    const maxLag=Math.min(this.diff.length-2,Math.floor(sr/65),Math.floor(N/2)-2);
    this.diff.fill(0);this.cmnd.fill(1);
    for(let tau=1;tau<=maxLag;tau++){
      let sum=0;
      const limit=N-tau;
      for(let i=0;i<limit;i++){
        const d=this.analysis[i]-this.analysis[i+tau];
        sum+=d*d;
      }
      this.diff[tau]=sum;
    }
    let running=0;
    for(let tau=1;tau<=maxLag;tau++){
      running+=this.diff[tau];
      this.cmnd[tau]=running>1e-12?this.diff[tau]*tau/running:1;
    }
    let tau=0;
    const threshold=.16;
    for(let t=minLag;t<=maxLag;t++){
      if(this.cmnd[t]<threshold){
        tau=t;
        while(tau+1<=maxLag&&this.cmnd[tau+1]<this.cmnd[tau])tau++;
        break;
      }
    }
    if(!tau){
      let best=1,bestTau=0;
      for(let t=minLag;t<=maxLag;t++)if(this.cmnd[t]<best){best=this.cmnd[t];bestTau=t;}
      if(best>.34||!bestTau)return;
      tau=bestTau;
    }
    let refined=tau;
    if(tau>minLag&&tau<maxLag){
      const a=this.cmnd[tau-1],b=this.cmnd[tau],c=this.cmnd[tau+1];
      const den=a-2*b+c;
      if(Math.abs(den)>1e-9)refined=tau+.5*(a-c)/den;
    }
    const confidence=Math.max(0,Math.min(1,1-this.cmnd[tau]));
    const freq=sr/refined;
    if(freq>=65&&freq<=1400&&confidence>=.55)this.pitchFreq=freq;
  }

  // Sets this.nearestMidi / this.nearestDist to the closest in-scale note.
  nearestAllowedMidi(midi){
    let target=Math.round(midi),best=Infinity;
    for(let n=Math.floor(midi)-12;n<=Math.ceil(midi)+12;n++){
      if(!this.allowed[((n%12)+12)%12])continue;
      const d=Math.abs(n-midi);
      if(d<best){best=d;target=n;}
    }
    this.nearestMidi=target;
    this.nearestDist=best;
  }

  updateTarget(){
    const strength=this.amount/100;
    if(!(this.pitchFreq>0)||!this.allowedCount||strength<=0){
      this.voiced=false;
      this.targetSemi=0;
      return;
    }
    let midi=69+12*Math.log2(this.pitchFreq/440);
    if(!Number.isFinite(midi)){this.voiced=false;this.targetSemi=0;return;}
    this.period=sampleRate/this.pitchFreq;

    // Median filtering kills octave flicker while keeping the high-strength mode quick enough for the
    // familiar stepped/robotic Auto-Tune transitions.
    this.history[this.historyPos]=midi;
    this.historyPos=(this.historyPos+1)%this.history.length;
    this.historyCount=Math.min(this.history.length,this.historyCount+1);
    midi=this.medianMidi(strength>.82?3:5);

    this.nearestAllowedMidi(midi);
    let target=this.nearestMidi;
    if(Number.isFinite(this.targetMidi)&&this.allowed[((this.targetMidi%12)+12)%12]){
      // More humanization at low settings; almost no hysteresis at 100%.
      const hysteresis=.04+(1-strength)*.28;
      if(Math.abs(this.targetMidi-midi)<=this.nearestDist+hysteresis)target=this.targetMidi;
    }
    this.targetMidi=target;

    // The amount sets how much of the distance to the note is corrected (and, below, how fast).
    const correction=Math.min(1,Math.pow(strength,.62));
    this.targetSemi=Math.max(-12,Math.min(12,(target-midi)*correction));
    this.voiced=true;
  }

  // Best read delay near `around` whose waveform matches the current head over the next samples
  // (normalized cross-correlation over +-span samples). Keeps the crossfade in step.
  alignDelay(around,span){
    const b=this.buffers[0],w=this.writeIndex,cur=this.d;
    const W=Math.max(32,Math.min(256,Math.floor(Math.min(cur,around-span))-4));
    let best=around,bestScore=-Infinity;
    for(let k=-span;k<=span;k++){
      const cand=around+k;
      if(cand<W+4||cand>this.ringSize-4)continue;
      let xy=0,yy=0;
      for(let j=0;j<W;j+=2){
        const a=this.sample(b,w-cur+j),c=this.sample(b,w-cand+j);
        xy+=a*c;yy+=c*c;
      }
      const score=yy>1e-12?xy/Math.sqrt(yy):-Infinity;
      if(score>bestScore){bestScore=score;best=cand;}
    }
    return best;
  }

  // Jump the head (dir +1 = further back, -1 = closer) and crossfade from where it was. In a pause
  // (exact) it goes straight to the centre: there is nothing to keep in step.
  startJump(dir,rate,exact=false){
    const P=!exact&&this.voiced&&this.period>24?this.period:0;
    let target;
    if(exact)target=this.center;
    else if(P){
      // Jump by whole periods back towards the centre (normally one): the two heads hold nearly the same
      // waveform, and the head stays within half a period of the centre, so the average delay is exactly the
      // latency parts.js compensates.
      const n=Math.max(1,Math.round(Math.abs(this.center-this.d)/P));
      target=this.d+dir*n*P;
      while(target<this.minDelay)target+=P;
      while(target>this.maxDelay)target-=P;
      target=this.alignDelay(target,Math.min(48,Math.round(P/4)));
    }else{
      target=this.alignDelay(this.center,48);
    }
    this.oldD=this.d;this.d=target;this.xPos=0;
    let len=P?Math.round(Math.min(1536,Math.max(256,2*P))):512;
    // Finish before the next jump is due, and never let the old head read ahead of what has been written.
    if(P&&Math.abs(rate)>1e-6)len=Math.min(len,Math.max(48,Math.floor(.6*P/Math.abs(rate))));
    if(rate>0)len=Math.max(48,Math.min(len,Math.floor((this.oldD-2)/rate)));
    this.xLen=len;
  }

  process(inputs,outputs){
    const input=inputs[0],output=outputs[0];
    if(this.released&&(!input||!input.length))return false;
    if(!output?.length)return true;
    const frames=output[0].length,channels=Math.min(output.length,this.buffers.length);
    const strength=this.amount/100,tuning=strength>.0001&&this.allowedCount>0;
    const lastInput=input&&input.length?input.length-1:-1;
    if(tuning)this.engaged=true;

    for(let i=0;i<frames;i++){
      let level=0;
      for(let ch=0;ch<channels;ch++){
        const src=lastInput>=0?input[Math.min(ch,lastInput)]:null;
        const v=src?src[i]||0:0;
        this.buffers[ch][this.writeIndex]=v;
        if(ch===0)level=v<0?-v:v;
      }
      this.env=level>this.env?level:this.env*this.envDecay;

      if(tuning){
        this.detectCounter++;
        if(this.detectCounter>=this.detectEvery){
          this.detectCounter=0;
          this.detectPitch(this.buffers[0]);
          this.updateTarget();
        }
      }else{
        this.voiced=false;this.targetSemi=0;this.detectCounter=0;
      }

      if(!this.engaged){
        // Bypass: the same latency as the tuned path.
        for(let ch=0;ch<channels;ch++)output[ch][i]=this.sample(this.buffers[ch],this.writeIndex-this.center);
      }else{
        // Retune speed: ~170 ms near 0%, down to ~2 ms at 100%, never faster than the slew limit.
        // Unvoiced sounds release gently to no shift.
        const retuneMs=this.voiced?(2+168*Math.pow(1-strength,2.35)):55;
        const alpha=1-Math.exp(-1/(sampleRate*(retuneMs/1000)));
        const desired=this.voiced?this.targetSemi:0;
        let step=(desired-this.semi)*alpha;
        if(step>this.maxSemiStep)step=this.maxSemiStep;
        else if(step<-this.maxSemiStep)step=-this.maxSemiStep;
        this.semi+=step;
        const rate=Math.exp(this.semi*LN2_OVER_12)-1; // output pitch / input pitch - 1 = delay change per sample
        this.d-=rate;
        if(this.xLen)this.oldD-=rate;

        if(!this.xLen){
          const half=(this.voiced&&this.period>24?this.period:256)*.5+1;
          if(this.d<this.center-half||this.d<this.minDelay)this.startJump(1,rate);
          else if(this.d>this.center+half||this.d>this.maxDelay)this.startJump(-1,rate);
          // During a pause, quietly move back to the centre so timing stays exact.
          else if(this.env<.003&&Math.abs(this.d-this.center)>32&&Math.abs(rate)<1e-4)this.startJump(this.center>this.d?1:-1,rate,true);
        }

        let g=1;
        if(this.xLen){const t=this.xPos/this.xLen;g=.5-.5*Math.cos(Math.PI*t);}
        for(let ch=0;ch<channels;ch++){
          const b=this.buffers[ch];
          let y=this.sample(b,this.writeIndex-this.d);
          if(this.xLen)y=y*g+this.sample(b,this.writeIndex-this.oldD)*(1-g);
          output[ch][i]=y;
        }
        if(this.xLen&&++this.xPos>=this.xLen)this.xLen=0;

        // Amount back at 0: settle to the bypass delay, then stop shifting.
        if(!tuning&&!this.xLen&&Math.abs(this.semi)<1e-4){
          if(Math.abs(this.d-this.center)<.5){this.engaged=false;this.semi=0;this.d=this.center;}
          else if(this.env<.003)this.startJump(this.center>this.d?1:-1,0,true);
          else if(Math.abs(this.d-this.center)>this.delayRange*.45)this.startJump(this.center>this.d?1:-1,0);
        }
      }
      this.writeIndex=(this.writeIndex+1)%this.ringSize;
    }
    return true;
  }
}
registerProcessor('crp-vocal-autotune',CRPVocalAutotuneProcessor);

// Vocal capture: streams the mic input back to the main thread in blocks
// stamped with their first frame (this context's currentFrame), so parts.js can
// cut the take at exact times. {type:'stop'} ends the stream: a final partial
// block, then {type:'done'}.
class CRPVocalRecorderProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.block=new Float32Array(4096);
    this.fill=0;
    this.blockFrame=0;
    this.stopped=false;
    this.port.onmessage=e=>{if(e.data?.type==='stop')this.stopped=true;};
  }
  flush(){
    if(!this.fill)return;
    const samples=this.block.slice(0,this.fill);
    this.port.postMessage({type:'audio',frame:this.blockFrame,samples},[samples.buffer]);
    this.fill=0;
  }
  process(inputs){
    if(this.stopped){this.flush();this.port.postMessage({type:'done'});return false;}
    const src=inputs[0]?.[0],frames=src?src.length:128;
    for(let i=0;i<frames;i++){
      if(!this.fill)this.blockFrame=currentFrame+i;
      this.block[this.fill++]=src?src[i]:0;
      if(this.fill===this.block.length)this.flush();
    }
    return true;
  }
}
registerProcessor('crp-vocal-recorder',CRPVocalRecorderProcessor);
