export default {
  apply(context) {
    for (const slot of context.slots) context.register(slot, (container, input, scope) => {
      container.style.display = 'contents';
      for (const name of input.regionNames ?? ['content']) scope.regions.mount(name, container);
      return { update() {}, dispose() {} };
    });
  },
};
