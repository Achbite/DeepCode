const selector = (element) => {
  const parts = [];
  for (let node = element; node?.nodeType === 1; node = node.parentElement) {
    if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
      parts.unshift('#' + CSS.escape(node.id)); break;
    }
    let part = node.localName;
    const siblings = [...(node.parentElement?.children ?? [])].filter(other => other.localName === node.localName);
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
  }
  return parts.join(' > ');
};
const elements = [...document.querySelectorAll('a,button,input,textarea,select,summary,[role],[tabindex],[contenteditable="true"]')]
  .filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.x < innerWidth && r.y < innerHeight && getComputedStyle(element).visibility !== 'hidden'; })
  .slice(0, 150).map(element => {
    const r = element.getBoundingClientRect();
    return { selector: selector(element), role: element.getAttribute('role') ?? element.localName,
      text: (element.getAttribute('aria-label') ?? element.innerText ?? '').slice(0,500),
      value: element instanceof HTMLInputElement && element.type === 'password' ? undefined : element.value,
      disabled: element.disabled ?? false, bounds: { x:r.x,y:r.y,width:r.width,height:r.height } };
  });
return {url:location.href,title:document.title,readyState:document.readyState,viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},text:document.body?.innerText.slice(0,16000)??'',elements,elementLimit:150};
