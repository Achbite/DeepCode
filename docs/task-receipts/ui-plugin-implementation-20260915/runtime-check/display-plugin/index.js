export default { apply(ctx) {
  ctx.addStyle('.tcr-plugin-view {font:13px -apple-system,system-ui;white-space:pre-wrap;padding:12px} .tcr-plugin-version {color:#167347;font-weight:600;margin-bottom:8px}');
  ctx.register('message.markdown', (container,input,scope)=>{
    container.classList.add('tcr-plugin-view');
    const version=document.createElement('div');version.className='tcr-plugin-version';version.textContent='展示插件 V2';
    const body=document.createElement('div');container.append(version,body);
    const update=value=>{body.textContent=value.text};update(input);
    return {update,async dispose(){version.remove();body.remove();container.classList.remove('tcr-plugin-view')}};
  });
}};
