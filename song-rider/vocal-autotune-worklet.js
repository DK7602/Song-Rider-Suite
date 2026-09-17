class CRPVocalAutotuneProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.amount=0;
    this.allowedPcs=[];
    this.targetMidi=null;
    this.lastMidi=null;
    this.ringSize=32768;
    this.writeIndex=0;
    this.buffers=[];

    // Pitch tracker: frequent YIN analysis gives a much steadier fundamental than
    // the old single autocorrelation peak, especially on sung vowels.
    this.frameSize=2048;
    this.downsample=2;
    this.analysisSize=this.frameSize/this.downsample;
    this.analysis=new Float32Array(this.analysisSize);
    this.diff=new Float32Array(512);
    this.cmnd=new Float32Array(512);
    this.detectEvery=512;
    this.detectCounter=0;
    this.midiHistory=[];

    // Low-latency dual-grain shifter.  The two overlapping read heads crossfade,
    // so fast retunes can jump notes without the hard clicks of a single delay tap.
    this.minDelay=384;
    this.delayRange=1792;
    this.phase=.5;
    this.ratio=1;
    this.targetRatio=1;
    this.voiced=false;

    this.port.onmessage=e=>{
      const d=e.data||{};
      if(Number.isFinite(Number(d.amount)))this.amount=Math.max(0,Math.min(100,Number(d.amount)));
      if(Array.isArray(d.allowedPcs))this.allowedPcs=d.allowedPcs.map(n=>((Math.round(Number(n))%12)+12)%12).filter((n,i,a)=>a.indexOf(n)===i);
    };
  }

  sample(buf,pos){
    const n=this.ringSize;
    while(pos<0)pos+=n;
    while(pos>=n)pos-=n;
    const i0=Math.floor(pos),i1=(i0+1)%n,f=pos-i0;
    return buf[i0]*(1-f)+buf[i1]*f;
  }

  median(values){
    if(!values.length)return 0;
    const a=[...values].sort((x,y)=>x-y);
    const m=a.length>>1;
    return a.length&1?a[m]:(a[m-1]+a[m])*.5;
  }

  detectPitch(buf){
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
    const rms=Math.sqrt(power/N);
    if(rms<0.006)return {freq:0,confidence:0};

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
      if(best>.34||!bestTau)return {freq:0,confidence:0};
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
    if(!(freq>=65&&freq<=1000)||confidence<.55)return {freq:0,confidence};
    return {freq,confidence};
  }

  nearestAllowedMidi(midi){
    let target=Math.round(midi),best=Infinity;
    for(let n=Math.floor(midi)-12;n<=Math.ceil(midi)+12;n++){
      const pc=((n%12)+12)%12;
      if(!this.allowedPcs.includes(pc))continue;
      const d=Math.abs(n-midi);
      if(d<best){best=d;target=n;}
    }
    return {target,best};
  }

  updateTarget(pitch){
    const strength=this.amount/100;
    if(!(pitch?.freq>0)||!this.allowedPcs.length||strength<=0){
      this.voiced=false;
      this.targetRatio=1;
      return;
    }
    let midi=69+12*Math.log2(pitch.freq/440);
    if(!Number.isFinite(midi)){this.voiced=false;this.targetRatio=1;return;}

    // Median filtering kills octave flicker while keeping the high-strength mode
    // quick enough to make the familiar stepped/robotic Auto-Tune transitions.
    this.midiHistory.push(midi);
    const historyLen=strength>.82?3:5;
    while(this.midiHistory.length>historyLen)this.midiHistory.shift();
    midi=this.median(this.midiHistory);
    this.lastMidi=midi;

    const nearest=this.nearestAllowedMidi(midi);
    let target=nearest.target,best=nearest.best;
    if(Number.isFinite(this.targetMidi)&&this.allowedPcs.includes(((this.targetMidi%12)+12)%12)){
      const heldDist=Math.abs(this.targetMidi-midi);
      // More humanization at low settings; almost zero hysteresis at 100% so
      // pitch jumps firmly to the next legal scale tone as soon as it crosses.
      const hysteresis=.04+(1-strength)*.28;
      if(heldDist<=best+hysteresis)target=this.targetMidi;
    }
    this.targetMidi=target;

    // Amount controls both correction depth and retune character. The nonlinear
    // mapping makes 60-100% progressively tighter instead of sounding nearly the same.
    const correction=Math.min(1,Math.pow(strength,.62));
    let semitones=(target-midi)*correction;
    // A real vocal can be several semitones off. The old +/-2-semitone clamp made
    // strong correction barely audible; allow up to an octave while remaining sane.
    semitones=Math.max(-12,Math.min(12,semitones));
    this.targetRatio=Math.pow(2,semitones/12);
    this.voiced=true;
  }

  process(inputs,outputs){
    const input=inputs[0],output=outputs[0];
    if(!output?.length)return true;
    const frames=output[0].length,channels=output.length;
    while(this.buffers.length<channels)this.buffers.push(new Float32Array(this.ringSize));

    for(let i=0;i<frames;i++){
      for(let ch=0;ch<channels;ch++){
        const src=input[Math.min(ch,Math.max(0,input.length-1))];
        this.buffers[ch][this.writeIndex]=src?src[i]||0:0;
      }

      this.detectCounter++;
      if(this.detectCounter>=this.detectEvery){
        this.detectCounter=0;
        this.updateTarget(this.detectPitch(this.buffers[0]));
      }

      const strength=this.amount/100;
      if(strength<=.0001||!this.allowedPcs.length){
        for(let ch=0;ch<channels;ch++){
          const src=input[Math.min(ch,Math.max(0,input.length-1))];
          output[ch][i]=src?src[i]||0:0;
        }
        this.ratio=1;
        this.phase=.5;
      }else{
        // Retune speed: ~170 ms near the natural end, down to ~2 ms at 100%.
        // Unvoiced consonants release gently to unity instead of warbling.
        const retuneMs=this.voiced?(2+168*Math.pow(1-strength,2.35)):55;
        const alpha=1-Math.exp(-1/(sampleRate*(retuneMs/1000)));
        const desired=this.voiced?this.targetRatio:1;
        this.ratio+=(desired-this.ratio)*alpha;

        // Four-semitone shifts and beyond remain stable because the grain read heads
        // wrap through a larger buffer. The two Hann windows always sum to ~1.
        const inc=(1-this.ratio)/this.delayRange;
        this.phase+=inc;
        this.phase-=Math.floor(this.phase);
        const p1=this.phase,p2=(p1+.5)%1;
        const w1=.5-.5*Math.cos(2*Math.PI*p1),w2=.5-.5*Math.cos(2*Math.PI*p2);
        const norm=Math.max(.0001,w1+w2);
        const d1=this.minDelay+p1*this.delayRange,d2=this.minDelay+p2*this.delayRange;
        const dryDelay=this.minDelay+this.delayRange*.5;

        // Wet rises quickly but continuously. At 100% the user hears only the tuned
        // signal; at small settings the delayed dry path keeps the vocal natural.
        const wet=Math.min(1,Math.pow(strength,.72)*1.08),dry=1-wet;
        for(let ch=0;ch<channels;ch++){
          const b=this.buffers[ch];
          const tuned=(this.sample(b,this.writeIndex-d1)*w1+this.sample(b,this.writeIndex-d2)*w2)/norm;
          const clean=this.sample(b,this.writeIndex-dryDelay);
          output[ch][i]=clean*dry+tuned*wet;
        }
      }
      this.writeIndex=(this.writeIndex+1)%this.ringSize;
    }
    return true;
  }
}
registerProcessor('crp-vocal-autotune',CRPVocalAutotuneProcessor);
