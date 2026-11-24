/* 家谱 / 亲戚谱 SVG 思维导图式渲染引擎 */
(function () {
  const CARD = { w: 196, h: 64, gapX: 76, gapY: 18, spouseGap: 10, topPad: 58 };
  const COLORS = {
    male: { accent: '#3f6b6e', soft: '#dee9e6' },
    female: { accent: '#a3503f', soft: '#f5e4dd' },
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function clipText(value, limit) {
    const str = String(value == null ? '' : value);
    return str.length > limit ? str.slice(0, limit) + '…' : str;
  }

  function yearRange(node) {
    if (node.birth_year && node.death_year) return `${node.birth_year}—${node.death_year}`;
    if (node.birth_year) return `生于${node.birth_year}`;
    if (node.death_year) return `卒于${node.death_year}`;
    return '';
  }

  function spouseListHeight(node) {
    const count = (node.spouses || []).length;
    return count ? count * (CARD.h + CARD.spouseGap) : 0;
  }

  function blockHeight(node) {
    return CARD.h + spouseListHeight(node);
  }

  function walk(node, fn) {
    fn(node);
    (node.children || []).forEach(child => walk(child, fn));
  }

  function layout(root) {
    function measure(node) {
      const kids = node.children || [];
      const block = blockHeight(node);
      if (!kids.length) {
        node._h = block;
        return node._h;
      }
      let sum = 0;
      let lastTop = 0;
      kids.forEach((kid, index) => {
        if (index) sum += CARD.gapY;
        lastTop = sum;
        sum += measure(kid);
      });
      // 父卡片以首/末子女中心对齐，配偶卡向下延伸，需为整块高度预留空间，
      // 否则新增成员（多出配偶卡）后整块会溢出到下方兄弟子树，导致重叠。
      node._h = Math.max(block, sum, lastTop / 2 + block);
      return node._h;
    }

    function place(node, depth, top) {
      node._depth = depth;
      node._x = depth * (CARD.w + CARD.gapX);
      const kids = node.children || [];
      if (!kids.length) {
        node._y = top;
        return;
      }
      let childTop = top;
      kids.forEach(kid => {
        place(kid, depth + 1, childTop);
        childTop += kid._h + CARD.gapY;
      });
      const first = kids[0];
      const last = kids[kids.length - 1];
      const middle = ((first._y + CARD.h / 2) + (last._y + CARD.h / 2)) / 2;
      node._y = middle - CARD.h / 2;
    }

    measure(root);
    place(root, 0, CARD.topPad);
  }

  function edgePath(from, to, relationType) {
    const x1 = from._x + CARD.w;
    const y1 = from._y + CARD.h / 2;
    const x2 = to._x;
    const y2 = to._y + CARD.h / 2;
    const mx = (x1 + x2) / 2;
    return `<path class="edge edge-${relationType || '血缘'}" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"/>`;
  }

  // 配偶卡连线：从配偶卡（父亲或母亲）右侧引出，连到子代左侧
  function spouseEdgePath(position, child) {
    const x1 = position.x + CARD.w;
    const y1 = position.y + CARD.h / 2;
    const x2 = child._x;
    const y2 = child._y + CARD.h / 2;
    const mx = (x1 + x2) / 2;
    return `<path class="edge edge-mother" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"/>`;
  }

  // 收集所有配偶卡的坐标，用于「子代 → 母亲」连线
  function spousePositions(nodes) {
    const positions = {};
    nodes.forEach(node => {
      (node.spouses || []).forEach((spouse, index) => {
        positions[spouse.id] = {
          x: node._x,
          y: node._y + CARD.h + CARD.spouseGap + index * (CARD.h + CARD.spouseGap),
        };
      });
    });
    return positions;
  }

  function avatarSvg(id, name, photo, palette) {
    if (!photo) {
      return `<circle cx="34" cy="32" r="21" fill="${palette.soft}"/>
        <text class="avatar-char" x="34" y="38" text-anchor="middle" fill="${palette.accent}">${esc(clipText(name, 1))}</text>`;
    }
    return `<clipPath id="clip-${id}"><circle cx="34" cy="32" r="21"/></clipPath>
      <circle cx="34" cy="32" r="21" fill="${palette.soft}"/>
      <image href="${esc(photo)}" x="13" y="11" width="42" height="42"
             clip-path="url(#clip-${id})" preserveAspectRatio="xMidYMid slice"/>
      <circle cx="34" cy="32" r="21" fill="none" stroke="${palette.accent}" stroke-opacity=".35"/>`;
  }

  // 每个成员姓名卡下方，渲染与主卡同尺寸的配偶信息卡
  function spouseCardsSvg(node) {
    const spouses = node.spouses || [];
    if (!spouses.length) return '';
    return spouses.map((sp, index) => {
      const female = sp.gender === '女';
      const palette = female ? COLORS.female : COLORS.male;
      const meta = ['配偶', `第${sp.generation || node.generation}代`, yearRange(sp)]
        .filter(Boolean).join(' · ');
      const y = CARD.h + CARD.spouseGap + index * (CARD.h + CARD.spouseGap);
      return `<g class="spouse-card" data-id="${sp.id}" transform="translate(0,${y})">
        <rect class="card spouse-box" width="${CARD.w}" height="${CARD.h}" rx="14"/>
        <rect x="0" y="10" width="3.5" height="44" rx="2" fill="${palette.accent}" opacity=".55"/>
        ${avatarSvg('sp-' + sp.id, sp.name, sp.photo, palette)}
        <text class="node-name" x="66" y="27">${esc(clipText(sp.name, 6))}</text>
        <text class="node-meta" x="66" y="48">${esc(meta)}</text>
        <text class="spouse-badge" x="${CARD.w - 12}" y="19" text-anchor="end">配</text>
      </g>`;
    }).join('');
  }

  function nodeSvg(node, opts) {
    const female = node.gender === '女';
    const palette = female ? COLORS.female : COLORS.male;
    const isFocus = opts.focusId === node.id;
    const isMatch = opts.highlightIds && opts.highlightIds.has(node.id);
    const isMe = opts.myId === node.id;
    const meta = [`第${node.generation}代`];
    if (node.sibling_rank) meta.push(`行${node.sibling_rank}`);
    const years = yearRange(node);
    if (years) meta.push(years);

    const focusRing = isFocus
      ? `<rect class="focus-ring" x="-7" y="-7" width="${CARD.w + 14}" height="${CARD.h + 14}" rx="18"/>
         <text class="focus-tag" x="${CARD.w + 4}" y="-11" text-anchor="end">中心</text>`
      : '';

    return `<g class="node${isFocus ? ' is-focus' : ''}${isMatch ? ' is-match' : ''}${isMe ? ' is-me' : ''}"
        data-id="${node.id}" transform="translate(${node._x},${node._y})">
      ${focusRing}
      ${isMe ? '<text class="me-tag" x="-7" y="-11" text-anchor="start">我</text>' : ''}
      <rect class="card" width="${CARD.w}" height="${CARD.h}" rx="14"/>
      <rect x="0" y="10" width="3.5" height="44" rx="2" fill="${palette.accent}" opacity=".8"/>
      ${avatarSvg(node.id, node.name, node.photo, palette)}
      <text class="node-name" x="66" y="27">${esc(clipText(node.name, 6))}</text>
      <text class="node-meta" x="66" y="48">${esc(meta.join(' · '))}</text>
      ${spouseCardsSvg(node)}
    </g>`;
  }

  function collectBounds(root, extras) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const nodes = [];
    walk(root, node => nodes.push(node));
    (extras || []).forEach(node => nodes.push(node));
    nodes.forEach(node => {
      minX = Math.min(minX, node._x);
      maxX = Math.max(maxX, node._x + CARD.w);
      minY = Math.min(minY, node._y);
      maxY = Math.max(maxY, node._y + blockHeight(node));
    });
    if (!nodes.length) return { x: 0, y: 0, w: CARD.w, h: CARD.h };
    return { x: minX, y: minY - 10, w: maxX - minX, h: maxY - minY + 40 };
  }

  function renderLineage(data, options) {
    const opts = options || {};
    const root = data.root;
    layout(root);

    const highlightIds = opts.highlightIds || null;
    const nodes = [];
    walk(root, node => nodes.push(node));

    let inner = '';
    const maxDepth = nodes.reduce((max, node) => Math.max(max, node._depth), 0);
    const bottom = nodes.reduce((max, node) => Math.max(max, node._y + blockHeight(node)), 0);
    const columnWidth = CARD.w + CARD.gapX;

    for (let depth = 0; depth <= maxDepth; depth += 1) {
      const generation = root.generation + depth;
      const centerX = depth * columnWidth + CARD.w / 2;
      inner += `<text class="col-label" x="${centerX}" y="24" text-anchor="middle">第 ${generation} 代</text>
        <line class="col-line" x1="${centerX}" y1="36" x2="${centerX}" y2="${bottom + 26}"/>`;
    }

    const spouses = spousePositions(nodes);
    nodes.forEach(node => {
      (node.children || []).forEach(child => {
        inner += edgePath(node, child, child.relation_type);
        // 另一位家长以配偶卡展示时，补一条「子代 → 家长」连线（父或母均适用）
        [child.father_id, child.mother_id].forEach(pid => {
          if (pid && pid !== node.id && spouses[pid]) {
            inner += spouseEdgePath(spouses[pid], child);
          }
        });
      });
    });
    nodes.forEach(node => {
      inner += nodeSvg(node, { focusId: null, highlightIds, myId: opts.myId });
    });

    return {
      inner,
      bounds: (() => {
        const bounds = collectBounds(root, []);
        bounds.y -= 30;
        bounds.h += 30;
        return bounds;
      })(),
      nodeCount: nodes.length,
    };
  }

  window.FamilyTree = { renderLineage, CARD };
})();
