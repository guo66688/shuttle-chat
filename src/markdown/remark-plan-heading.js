// src/markdown/remark-plan-heading.js
// 作用：把“方案1（xxx）：/方案1：”提升为 ### 标题节点（统一版式）
export default function remarkPlanHeading() {
  const re1 = /^\s*方案(\d+)\s*[（(]([^)）]+)[)）]\s*[:：]?\s*$/;
  const re2 = /^\s*方案(\d+)\s*[:：]\s*$/;

  return (tree) => {
    const out = [];
    for (const node of (tree.children || [])) {
      if (node.type === 'paragraph' && node.children?.[0]?.type === 'text') {
        const raw = String(node.children[0].value || '').trim();
        const m1 = raw.match(re1);
        const m2 = raw.match(re2);
        if (m1 || m2) {
          const title = m1 ? `方案${m1[1]}（${m1[2]}）` : `方案${m2[1]}`;
          out.push({
            type: 'heading',
            depth: 3,
            children: [{ type: 'text', value: title }],
          });
          continue; // 丢掉原段落
        }
      }
      out.push(node);
    }
    tree.children = out;
  };
}
