// src/markdown/remark-remove-system-lines.js
// 作用：移除模型/调试噪声段落（如 Observation/Thought/Action/AI:）
export default function remarkRemoveSystemLines() {
  const patterns = [
    /^(?:Observation|Thought|Action(?:\s+Input)?)\s*:/i,
    /^AI:\s*/i,
  ];
  const isNoise = (text) => patterns.some((re) => re.test(text));

  return (tree) => {
    tree.children = (tree.children || []).filter((node) => {
      if (node.type !== 'paragraph') return true;
      if (!node.children || node.children.length !== 1) return true;
      const child = node.children[0];
      if (child.type !== 'text') return true;
      return !isNoise(String(child.value || '').trim());
    });
  };
}
