import React,{useState} from 'react';
import {hasNativeBrowser,nativeBrowserCommand,nativeHostBinding,type NativePage} from '../../services/nativeBrowser';
import {requestReader} from './readerState';

export function BrowserPagesMenu({sessionId}:{sessionId:string|null}) {
  const [pages,setPages]=useState<NativePage[]>([]),[error,setError]=useState<string|null>(null);
  if(!hasNativeBrowser() || !sessionId) return null;
  const load=async()=>{
    try{const binding=await nativeHostBinding();if(!binding)return;const result=await nativeBrowserCommand<{pages:NativePage[]}>( {...binding,sessionId},{action:'list'});setPages(result.pages);setError(null);}catch(reason){setError(String(reason));}
  };
  const open=(target:Parameters<typeof requestReader>[1],event:React.MouseEvent<HTMLButtonElement>)=>{
    event.currentTarget.closest('details')?.removeAttribute('open');requestReader(sessionId,target);
  };
  return <details className="browser-pages-menu" onToggle={(event)=>{if(event.currentTarget.open)void load();}}>
    <summary>浏览器</summary>
    <div role="group" aria-label="浏览器页面">
      <button type="button" onClick={(event)=>open({kind:'browser'},event)}>新建页面</button>
      <button type="button" onClick={(event)=>open({kind:'browser',selfPreview:true},event)}>预览 DeepCode</button>
      {pages.map((page)=><button key={page.previewId} type="button" onClick={(event)=>open({kind:'browser',previewId:page.previewId},event)}>{page.url} · {page.status}</button>)}
      {error&&<p role="alert">{error}</p>}
    </div>
  </details>;
}
