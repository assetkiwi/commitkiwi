<script lang="ts">
  import { IN, PASS, type GraphLayout } from "../lib/graph";

  let { layout, i, h, w, merge = false, collapsed = false }: {
    layout: GraphLayout | null; i: number; h: number; w: number; merge?: boolean;
    /** a merge whose merged-in commits are hidden (Left): drawn with a plus */
    collapsed?: boolean;
  } = $props();
  const MAX_COL = 9; // lanes beyond this share the last column
  const x = (lane: number) => 12 + Math.min(lane, MAX_COL) * 12;
  const mid = $derived(h / 2);

  const paths = $derived.by(() => {
    if (!layout) return [{ d: `M${x(0)} 0V${h}`, c: 0 }]; // until the layout arrives: one straight lane
    const out: { d: string; c: number }[] = [];
    for (let e = layout.start[i]; e < layout.start[i + 1]; e++) {
      const [a, b, type, c] = [layout.edges[e * 4], layout.edges[e * 4 + 1], layout.edges[e * 4 + 2], layout.edges[e * 4 + 3]];
      const [xa, xb] = [x(a), x(b)];
      const d =
        type === PASS ? `M${xa} 0V${h}`
        : type === IN ? (xa === xb ? `M${xa} 0V${mid}` : `M${xa} 0C${xa} ${mid} ${xb} 0 ${xb} ${mid}`)
        : xa === xb ? `M${xa} ${mid}V${h}` : `M${xa} ${mid}C${xa} ${h} ${xb} ${mid} ${xb} ${h}`;
      out.push({ d, c });
    }
    return out;
  });
  const nodeX = $derived(x(layout ? layout.nodeLane[i] : 0));
  const nodeColor = $derived(layout ? layout.nodeColor[i] : 0);
</script>

<svg class="g" width={w} height={h} aria-hidden="true">
  {#each paths as p}<path d={p.d} stroke="var(--lane{p.c})" stroke-width="2" fill="none" />{/each}
  {#if merge}
    <circle cx={nodeX} cy={mid} r={collapsed ? 6 : 4.5} fill="var(--surface)" stroke="var(--lane{nodeColor})" stroke-width="2" />
    {#if collapsed}<path class="plus" d="M{nodeX - 3} {mid}h6M{nodeX} {mid - 3}v6" stroke="var(--lane{nodeColor})" stroke-width="1.6" />{/if}
  {:else}
    <circle cx={nodeX} cy={mid} r="5" fill="var(--lane{nodeColor})" stroke="var(--surface)" stroke-width="2.5" />
  {/if}
</svg>
