import React,{useEffect,useRef,useState} from 'react';
import type {UiLanguage} from '../../../i18n';
import {useSettingsStore} from '../../../state/settingsStore';
type Server={id:string;name:string;transport:string;command:string;args:string;enabled:boolean};
function decode(encoded:string):Server[]{const value:unknown=JSON.parse(encoded);if(!Array.isArray(value)||value.some((item)=>!item||typeof item.id!=='string'||typeof item.command!=='string'))throw new Error('mcp.servers must contain server IDs and commands.');return value;}
export default function FunctionalPluginSettings({language,query=''}:{language:UiLanguage;query?:string}){
  const chinese=language==='zh-CN';
  const encoded=String(useSettingsStore((state)=>state.effectiveSettings['mcp.servers'])??'[]');
  const patch=useSettingsStore((state)=>state.patchUserSetting);
  const [servers,setServers]=useState<Server[]>([]),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[saving,setSaving]=useState(false);
  const dirty=useRef(new Set<string>());
  useEffect(()=>{try{const saved=decode(encoded);setServers((drafts)=>[...saved.map((item)=>dirty.current.has(item.id)?drafts.find((draft)=>draft.id===item.id)??item:item),...drafts.filter((draft)=>dirty.current.has(draft.id)&&!saved.some((item)=>item.id===draft.id))]);setError(null);}catch(reason){setError(String(reason));}},[encoded]);
  const server=servers.find((item)=>item.id===selected);
  const save=async(remove=false)=>{if(!server)return;setSaving(true);setError(null);try{const saved=decode(String(useSettingsStore.getState().effectiveSettings['mcp.servers']??'[]'));const next=remove?saved.filter((item)=>item.id!==server.id):saved.some((item)=>item.id===server.id)?saved.map((item)=>item.id===server.id?server:item):[...saved,server];if(!await patch('mcp.servers',JSON.stringify(next)))throw new Error(useSettingsStore.getState().errorMessage??'Plugin configuration was not saved.');dirty.current.delete(server.id);if(remove){setSelected(null);setServers((items)=>items.filter((item)=>item.id!==server.id));}}catch(reason){setError(String(reason));}finally{setSaving(false);}};
  const edit=(value:Partial<Server>)=>{if(selected)dirty.current.add(selected);setServers((items)=>items.map((item)=>item.id===selected?{...item,...value}:item));};
  return <section className="settings-group">
    <div className="settings-plugin-master-detail">
      <nav aria-label={chinese?'功能插件':'Functional plugins'}>{servers.filter((item)=>`${item.name} ${item.id} ${item.command}`.toLowerCase().includes(query.toLowerCase())).map((item)=><button className="settings-button" type="button" key={item.id} aria-current={selected===item.id?'page':undefined} onClick={()=>setSelected(item.id)}>{item.name||item.id}</button>)}
        <button className="settings-button" type="button" onClick={()=>{const id=`mcp-${crypto.randomUUID()}`;dirty.current.add(id);setServers((items)=>[...items,{id,name:'',command:'',transport:'stdio',args:'',enabled:true}]);setSelected(id);}}>{chinese?'添加插件…':'Add plugin…'}</button></nav>
      {server?<div className="settings-card settings-card__body">
        <label className="settings-field">{chinese?'名称':'Name'}<input className="settings-field__input" value={server.name} onChange={(event)=>edit({name:event.target.value})}/></label>
        <label className="settings-field">{chinese?'启动命令':'Command'}<input className="settings-field__input" value={server.command} onChange={(event)=>edit({command:event.target.value})}/></label>
        <label className="settings-field">{chinese?'参数':'Arguments'}<input className="settings-field__input" value={server.args} onChange={(event)=>edit({args:event.target.value})}/></label>
        <label className="settings-field"><input type="checkbox" checked={server.enabled!==false} onChange={(event)=>edit({enabled:event.target.checked})}/>{chinese?'启用':'Enabled'}</label>
        <div className="settings-actions"><button className="settings-button settings-button--primary" disabled={saving||!server.command.trim()} onClick={()=>void save()}>{chinese?'保存此插件':'Save plugin'}</button><button className="settings-button" disabled={saving} onClick={()=>void save(true)}>{chinese?'移除':'Remove'}</button></div>
      </div>:<p>{chinese?'选择一个插件查看其配置。':'Select a plugin to view its settings.'}</p>}
    </div>
    {error&&<p role="alert" className="settings-error">{error}</p>}
  </section>;
}
