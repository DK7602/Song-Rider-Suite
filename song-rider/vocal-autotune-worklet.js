class CRPVocalAutotuneProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.amount=0;this.allowedPcs=[];this.targetMidi=null;this.ringSize=8192;this.writeIndex=0;this.buffers=[];this.phase=0;this.ratio=1;this.targetRatio=1;this.detectCounter=0;
    this.minDelay=512;this.delayRange=1024;this.detectEvery=2048;this.frameSize=2048;this.downsample=4;this.scratch=new Float32Array(this.frameSize/this.downsample);this.corr=new Float32Array(256);
    this.port.onmessage=e=>{const d=e.data||{};if(Number.isFinite(Number(d.amount)))this.amount=Math.max(0,Math.min(100,Number(d.amount)));if(Array.isArray(d.allowedPcs))this.allowedPcs=d.allowedPcs.map(n=>((Math.round(Number(n))%12)+12)%12).filter((n,i,a)=>a.indexOf(n)===i);};
  }
  sample(buf,pos){const n=this.ringSize;while(pos<0)pos+=n;while(pos>=n)pos-=n;const i0=Math.floor(pos),i1=(i0+1)%n,f=pos-i0;return buf[i0]*(1-f)+buf[i1]*f;}
  detectPitch(buf){
    const N=this.scratch.length,ds=this.downsample,sr=sampleRate/ds;let mean=0;
    const start=this.writeIndex-this.frameSize;
    for(let i=0;i<N;i++){const v=this.sample(buf,start+i*ds);this.scratch[i]=v;mean+=v;}mean/=N;
    let power=0;for(let i=0;i<N;i++){const v=this.scratch[i]-mean;this.scratch[i]=v;power+=v*v;}if(Math.sqrt(power/N)<0.008)return 0;
    const minLag=Math.max(2,Math.floor(sr/1000)),maxLag=Math.min(220,Math.floor(sr/70),N-8);let bestLag=0,best=-1;
    for(let lag=minLag;lag<=maxLag;lag++){let xy=0,xx=0,yy=0;const lim=N-lag;for(let i=0;i<lim;i++){const a=this.scratch[i],b=this.scratch[i+lag];xy+=a*b;xx+=a*a;yy+=b*b;}const c=(xx>1e-9&&yy>1e-9)?xy/Math.sqrt(xx*yy):0;this.corr[lag]=c;if(c>best){best=c;bestLag=lag;}}
    if(best<0.48||!bestLag)return 0;
    let lag=bestLag;if(bestLag>minLag&&bestLag<maxLag){const a=this.corr[bestLag-1],b=this.corr[bestLag],c=this.corr[bestLag+1],den=a-2*b+c;if(Math.abs(den)>1e-6)lag=bestLag+.5*(a-c)/den;}
    return sr/lag;
  }
  updateTarget(freq){
    if(!(freq>0)||!this.allowedPcs.length||this.amount<=0){this.targetRatio=1;return;}
    const midi=69+12*Math.log2(freq/440);let target=Math.round(midi),best=Infinity;
    for(let n=Math.floor(midi)-6;n<=Math.ceil(midi)+6;n++){const pc=((n%12)+12)%12;if(!this.allowedPcs.includes(pc))continue;const d=Math.abs(n-midi);if(d<best){best=d;target=n;}}
    if(Number.isFinite(this.targetMidi)&&this.allowedPcs.includes(((this.targetMidi%12)+12)%12)){const heldDist=Math.abs(this.targetMidi-midi);if(heldDist<=best+.35)target=this.targetMidi;}
    if(!Number.isFinite(target)){this.targetRatio=1;return;}this.targetMidi=target;
    const strength=this.amount/100,semi=(target-midi)*strength;this.targetRatio=Math.max(0.89,Math.min(1.12,Math.pow(2,semi/12)));
  }
  process(inputs,outputs){
    const input=inputs[0],output=outputs[0];if(!output?.length)return true;const frames=output[0].length,channels=output.length;
    while(this.buffers.length<channels)this.buffers.push(new Float32Array(this.ringSize));
    for(let i=0;i<frames;i++){
      for(let ch=0;ch<channels;ch++){const src=input[Math.min(ch,input.length-1)];this.buffers[ch][this.writeIndex]=src?src[i]||0:0;}
      this.detectCounter++;if(this.detectCounter>=this.detectEvery){this.detectCounter=0;this.updateTarget(this.detectPitch(this.buffers[0]));}
      const strength=this.amount/100,alpha=strength>=.98?.92:(.12+.58*strength);this.ratio+=(this.targetRatio-this.ratio)*alpha;
      if(this.amount<=0.001||!this.allowedPcs.length){for(let ch=0;ch<channels;ch++){const src=input[Math.min(ch,input.length-1)];output[ch][i]=src?src[i]||0:0;}}
      else{
        const inc=(1-this.ratio)/this.delayRange;this.phase+=inc;this.phase-=Math.floor(this.phase);const p1=this.phase,p2=(p1+.5)%1,d1=this.minDelay+p1*this.delayRange,d2=this.minDelay+p2*this.delayRange,w1=.5-.5*Math.cos(2*Math.PI*p1),w2=1-w1;
        for(let ch=0;ch<channels;ch++){const b=this.buffers[ch],s1=this.sample(b,this.writeIndex-d1),s2=this.sample(b,this.writeIndex-d2);output[ch][i]=s1*w1+s2*w2;}
      }
      this.writeIndex=(this.writeIndex+1)%this.ringSize;
    }
    return true;
  }
}
registerProcessor('crp-vocal-autotune',CRPVocalAutotuneProcessor);
