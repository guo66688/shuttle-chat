// src/markdown/remark-typography.js
// 作用：微排版（箭头两侧空格等），自动跳过 code/inlineCode，避免误伤
export default function remarkTypography() {
  function visit(node, inCode = false) {
    const nowInCode = inCode || node.type === 'code' || node.type === 'inlineCode';
    if (node.type === 'text' && !nowInCode) {
      node.value = String(node.value || '')
        .replace(/\s*→\s*/g, ' → ');
      // 其他排版（如空行折叠）可交给 Markdown 渲染层；必要再扩展
    }
    if (node.children) node.children.forEach((child) => visit(child, nowInCode));
  }
  return (tree) => visit(tree, false);
}
