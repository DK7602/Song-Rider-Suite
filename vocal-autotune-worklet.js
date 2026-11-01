// Vocal Auto-Tune: YIN pitch tracking plus a low-latency two-head (dual grain)
// pitch shifter.
//
// Latency is constant: the dry path and both tuned read heads are centred on
// minDelay + delayRange / 2 samples whether correction is on or bypassed, so a
// live amount change never shifts timing. parts.js passes minDelay/delayRange
// and compensates that latency when it schedules vocal clips.
//
// process() allocates nothing. Pitch detection only runs while the amount is
// above 0. After parts.js sends {type:'release'} (its chain was torn down), the
// processor returns false once its input is gone so the node can be collected.
const LN2_OVER_12=Math.LN2/12;
// Correction may not move faster than this many semitones per second. Large
// retunes otherwise jump the read-head rate abruptly, which is the main source
// of warble on shifts beyond a couple of semitones.
const MAX_SEMITONES_PER_SECOND=160;

class CRPVocalAutotuneProcessor extends AudioWorkletProcessor {
  constructor(options){
    super();
    const o=options?.processorOptions||{};
    this.minDelay=Number(o.minDelay)>0?Number(o.minDelay):384;
    this.delayRange=Number(o.delayRange)>0?Number(o.delayRange):1792;
    this.dryDelay=this.minDelay+this.delayRange*.5;
    this.amount=0;
    this.allowed=new Uint8Array(12);
    this.allowedCount=0;
    this.released=false;

    this.ringSize=32768;
    this.writeIndex=0;
    const channels=Math.max(1,Number(options?.outputChannelCount?.[0])||1);
    this.buffers=Array.from({length:channels},()=>new Float32Array(this.ringSize));

    // Pitch tracker: frequent YIN analysis gives a much steadier fundamental than
    // a single autocorrelation peak, especially on sung vowels.
    this.frameSize=2048;
    this.downsample=2;
    this.analysisSize=this.frameSize/this.downsample;
    this.analysis=new Float32Array(this.analysisSize);
    this.diff=new Float32Array(512);
    this.cmnd=new Float32Array(512);
    this.detectEvery=512;
    this.detectCounter=0;
    this.pitchFreq=0;
    this.history=new Float32Array(5);
    this.historyCount=0;
    this.historyPos=0;
    this.sorted=new Float32Array(5);
    this.targetMidi=NaN;
    this.nearestMidi=0;
    this.nearestDist=0;

    // Shifter state. semi is the current shift in semitones; targetSemi is what
    // the tracker asks for.
    this.phase=.5;
    this.semi=0;
    this.targetSemi=0;
    this.voiced=false;
    this.maxSemiStep=MAX_SEMITONES_PER_SECOND/sampleRate;

    this.port.onmessage=e=>{
      const d=e.data||{};
      if(d.type==='release'){this.released=true;return;}
      if(Number.isFinite(Number(d.amount)))this.amount=Math.max(0,Math.min(100,Number(d.amount)));
      if(Array.isArray(d.allowedPcs)){
        this.allowed.fill(0);
        for(const n of d.allowedPcs){const pc=((Math.round(Number(n))%12)+12)%12;if(Number.isFinite(pc))this.allowed[pc]=1;}
        this.allowedCount=this.allowed.reduce((a,b)=>a+b,0);
      }
    };
  }

  sample(buf,pos){
    const n=this.ringSize;
    while(pos<0)pos+=n;
    while(pos>=n)pos-=n;
    const i0=Math.floor(pos),i1=(i0+1)%n,f=pos-i0;
    return buf[i0]*(1-f)+buf[i1]*f;
  }

  // Median of the last `count` tracked pitches, via an insertion sort into a
  // preallocated scratch array.
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
      // Average each downsample pair. This reduces high-frequency noise without a
      // separate filter and makes the pitch detector more stable on consonants.
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

    const minLag=Math.max(2,Math.floor(sr/1000));
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

    // YIN threshold, then walk to the local minimum. A fallback global minimum is
    // used on breathier notes so pitch correction does not disappear mid-word.
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

    // Parabolic refinement gives smoother cents estimates between integer lags.
    let refined=tau;
    if(tau>minLag&&tau<maxLag){
      const a=this.cmnd[tau-1],b=this.cmnd[tau],c=this.cmnd[tau+1];
      const den=a-2*b+c;
      if(Math.abs(den)>1e-9)refined=tau+.5*(a-c)/den;
    }
    const confidence=Math.max(0,Math.min(1,1-this.cmnd[tau]));
    const freq=sr/refined;
    if(freq>=65&&freq<=1000&&confidence>=.55)this.pitchFreq=freq;
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

    // Median filtering kills octave flicker while keeping the high-strength mode
    // quick enough to make the familiar stepped/robotic Auto-Tune transitions.
    this.history[this.historyPos]=midi;
    this.historyPos=(this.historyPos+1)%this.history.length;
    this.historyCount=Math.min(this.history.length,this.historyCount+1);
    midi=this.medianMidi(strength>.82?3:5);

    this.nearestAllowedMidi(midi);
    let target=this.nearestMidi;
    if(Number.isFinite(this.targetMidi)&&this.allowed[((this.targetMidi%12)+12)%12]){
      // More humanization at low settings; almost zero hysteresis at 100% so
      // pitch jumps firmly to the next legal scale tone as soon as it crosses.
      const hysteresis=.04+(1-strength)*.28;
      if(Math.abs(this.targetMidi-midi)<=this.nearestDist+hysteresis)target=this.targetMidi;
    }
    this.targetMidi=target;

    // Amount controls both correction depth and retune character. The nonlinear
    // mapping makes 60-100% progressively tighter instead of sounding nearly the same.
    const correction=Math.min(1,Math.pow(strength,.62));
    // A real vocal can be several semitones off; allow up to an octave.
    this.targetSemi=Math.max(-12,Math.min(12,(target-midi)*correction));
    this.voiced=true;
  }

  process(inputs,outputs){
    const input=inputs[0],output=outputs[0];
    if(this.released&&(!input||!input.length))return false;
    if(!output?.length)return true;
    const frames=output[0].length,channels=Math.min(output.length,this.buffers.length);
    const strength=this.amount/100,tuning=strength>.0001&&this.allowedCount>0;
    const lastInput=input&&input.length?input.length-1:-1;

    for(let i=0;i<frames;i++){
      for(let ch=0;ch<channels;ch++){
        const src=lastInput>=0?input[Math.min(ch,lastInput)]:null;
        this.buffers[ch][this.writeIndex]=src?src[i]||0:0;
      }

      if(tuning){
        this.detectCounter++;
        if(this.detectCounter>=this.detectEvery){
          this.detectCounter=0;
          this.detectPitch(this.buffers[0]);
          this.updateTarget();
        }
      }

      if(!tuning){
        // Bypass keeps the same latency as the tuned path.
        for(let ch=0;ch<channels;ch++)output[ch][i]=this.sample(this.buffers[ch],this.writeIndex-this.dryDelay);
        this.semi=0;
        this.phase=.5;
        this.voiced=false;
        this.detectCounter=0;
      }else{
        // Retune speed: ~170 ms near the natural end, down to ~2 ms at 100%,
        // never faster than the slew limit. Unvoiced consonants release gently
        // to unity instead of warbling.
        const retuneMs=this.voiced?(2+168*Math.pow(1-strength,2.35)):55;
        const alpha=1-Math.exp(-1/(sampleRate*(retuneMs/1000)));
        const desired=this.voiced?this.targetSemi:0;
        let step=(desired-this.semi)*alpha;
        if(step>this.maxSemiStep)step=this.maxSemiStep;
        else if(step<-this.maxSemiStep)step=-this.maxSemiStep;
        this.semi+=step;
        const ratio=Math.exp(this.semi*LN2_OVER_12);

        // The grain read heads wrap through a large buffer and the two Hann
        // windows always sum to ~1.
        this.phase+=(1-ratio)/this.delayRange;
        this.phase-=Math.floor(this.phase);
        const p1=this.phase,p2=(p1+.5)%1;
        const w1=.5-.5*Math.cos(2*Math.PI*p1),w2=.5-.5*Math.cos(2*Math.PI*p2);
        const norm=Math.max(.0001,w1+w2);
        const d1=this.minDelay+p1*this.delayRange,d2=this.minDelay+p2*this.delayRange;

        // Wet rises quickly but continuously. At 100% the user hears only the tuned
        // signal; at small settings the delayed dry path keeps the vocal natural.
        const wet=Math.min(1,Math.pow(strength,.72)*1.08),dry=1-wet;
        for(let ch=0;ch<channels;ch++){
          const b=this.buffers[ch];
          const tuned=(this.sample(b,this.writeIndex-d1)*w1+this.sample(b,this.writeIndex-d2)*w2)/norm;
          const clean=this.sample(b,this.writeIndex-this.dryDelay);
          output[ch][i]=clean*dry+tuned*wet;
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
// cut the take at exact times. {type:'stop'} ends the stream after a final
// partial block.
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
    if(this.stopped){this.flush();return false;}
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
