import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPut, DEMO } from '../config';

export function useWindowState(room, hours=24) {
  const [snapshot,setSnapshot]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const generation=useRef(0),saving=useRef(false);
  const path=`/window-state?room=${encodeURIComponent(room)}&hours=${hours}`;
  const cancelRequests=useCallback(()=>{generation.current++;},[]);
  const load=useCallback(async()=>{
    if(DEMO||saving.current)return;
    const id=++generation.current;
    try {const data=await apiGet(path,{signal:AbortSignal.timeout(10000)});if(id===generation.current){setSnapshot(data);setError('');}}
    catch {if(id===generation.current)setError('Window status is unavailable.');}
  },[path]);
  useEffect(()=>{
    const first=setTimeout(load,0),timer=setInterval(load,15000);
    return()=>{cancelRequests();clearTimeout(first);clearInterval(timer);};
  },[load,cancelRequests]);
  const declare=async(isOpen)=>{
    if(saving.current||DEMO)return;
    saving.current=true;setBusy(true);const id=++generation.current;
    try {const data=await apiPut(path,{is_open:isOpen});if(id===generation.current){setSnapshot(data);setError('');}}
    catch {if(id===generation.current)setError('Could not save window status. Please try again.');}
    finally{saving.current=false;setBusy(false);}
  };
  const data=snapshot?.room===room?snapshot:null;
  return {data,error,busy,declare,disabled:DEMO||busy,
    visualState:!error&&data&&!data.needs_confirmation?data.state:'unknown'};
}
