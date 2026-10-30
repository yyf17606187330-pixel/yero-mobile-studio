import React, {useEffect, useRef} from 'react';

// Dots stay on the same grid; a slowly moving field changes their radius.
export function pixelAppearance(column:number,row:number,columns:number,rows:number,time:number){
 const x=(column+.5)/columns,y=(row+.5)/rows;
 const ax=.5+.25*Math.sin(time*.35),ay=.5+.25*Math.cos(time*.30);
 const bx=.5-.25*Math.cos(time*.27),by=.5+.20*Math.sin(time*.32);
 const first=Math.exp(-((x-ax)**2/.045+(y-ay)**2/.085));
 const second=Math.exp(-((x-bx)**2/.05+(y-by)**2/.075));
 const strength=Math.min(1,Math.max(first,second*.7));
 return {radius:.5+1.65*strength,opacity:.19+.57*strength};
}

export function PixelWave(){
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{
  const canvas=ref.current;if(!canvas||typeof window.CanvasRenderingContext2D==='undefined'||typeof window.requestAnimationFrame!=='function')return;
  let ctx:CanvasRenderingContext2D|null;try{ctx=canvas.getContext('2d');}catch{return;}if(!ctx)return;
  const context=ctx, host=canvas.parentElement, motion=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let visible=typeof window.IntersectionObserver!=='function',frame=0,width=0,height=0,lastDraw=0,previous=0,elapsed=0,disposed=false;
  let ink=window.getComputedStyle(canvas).color;
  const resize=()=>{
   const bounds=canvas.getBoundingClientRect();width=Math.round(bounds.width);height=Math.round(bounds.height);
   if(!width||!height)return;
   const ratio=Math.min(window.devicePixelRatio||1,1.5);
   canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);context.setTransform(ratio,0,0,ratio,0,0);
  };
  const draw=(timestamp:number)=>{
   frame=0;if(disposed||!visible||document.hidden||motion?.matches)return;
   if(!previous)previous=timestamp;
   elapsed+=Math.min(.1,Math.max(0,(timestamp-previous)/1000));previous=timestamp;
   if(timestamp-lastDraw>=50&&width&&height){
    lastDraw=timestamp;context.clearRect(0,0,width,height);context.fillStyle=ink;
    const columns=Math.max(1,Math.floor(width/18)),rows=Math.max(1,Math.floor(height/18));
    const startX=(width-(columns-1)*18)/2,startY=(height-(rows-1)*18)/2;
    for(let row=0;row<rows;row++)for(let column=0;column<columns;column++){
     const point=pixelAppearance(column,row,columns,rows,elapsed);context.globalAlpha=point.opacity;
     context.beginPath();context.arc(startX+column*18,startY+row*18,point.radius,0,Math.PI*2);context.fill();
    }
    context.globalAlpha=1;
   }
   frame=window.requestAnimationFrame(draw);
  };
  const sync=()=>{
   const active=!disposed&&visible&&!document.hidden&&!motion?.matches&&!!width&&!!height;
   if(active&&!frame){if(host)host.dataset.pixelCanvas='active';previous=0;lastDraw=0;frame=window.requestAnimationFrame(draw);}
   if(!active){if(frame)window.cancelAnimationFrame(frame);frame=0;previous=0;context.clearRect(0,0,width,height);if(host)delete host.dataset.pixelCanvas;}
  };
  const onResize=()=>{resize();sync();};
  const onColor=()=>{ink=window.getComputedStyle(canvas).color;};
  const intersection=typeof window.IntersectionObserver==='function'?new window.IntersectionObserver(entries=>{visible=!!entries[0]?.isIntersecting;sync();}):null;
  const sizeObserver=typeof window.ResizeObserver==='function'?new window.ResizeObserver(onResize):null;
  const themeRoot=canvas.closest('.mobile-studio');
  const themeObserver=themeRoot&&typeof window.MutationObserver==='function'?new window.MutationObserver(onColor):null;
  intersection?.observe(canvas);sizeObserver?.observe(canvas);if(themeRoot)themeObserver?.observe(themeRoot,{attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',onResize);document.addEventListener('visibilitychange',sync);
  if(motion?.addEventListener)motion.addEventListener('change',sync);else motion?.addListener?.(sync);
  resize();sync();
  return()=>{disposed=true;if(frame)window.cancelAnimationFrame(frame);intersection?.disconnect();sizeObserver?.disconnect();themeObserver?.disconnect();window.removeEventListener('resize',onResize);document.removeEventListener('visibilitychange',sync);if(motion?.removeEventListener)motion.removeEventListener('change',sync);else motion?.removeListener?.(sync);if(host)delete host.dataset.pixelCanvas;};
 },[]);
 return <canvas ref={ref} className="pixel-wave" aria-hidden="true"/>;
}
