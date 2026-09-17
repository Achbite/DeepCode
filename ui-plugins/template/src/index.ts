import type {UiPluginModule} from '../../../userspace/gui/src/ui-plugins/types';
export default {
  apply(context) {
    context.addStyle('.example-message { font: 15px/1.6 system-ui; white-space: pre-wrap; padding: 12px 16px; border-inline-start: 3px solid currentColor; }');
    context.register('message.plain', (container, input, scope) => {
      const text=document.createElement('div');text.className='example-message';container.append(text);
      const update=(next:typeof input)=>{if(next.kind==='message')text.textContent=next.text;};update(input);
      text.addEventListener('click',()=>text.focus(),{signal:scope.signal});
      return {update,dispose(){text.remove();}};
    });
  },
} satisfies UiPluginModule;
