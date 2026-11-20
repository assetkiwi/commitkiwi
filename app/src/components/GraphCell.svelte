<script lang="ts">
  import { IN, MAX_COL, PASS, laneX as x, type GraphLayout } from "../lib/graph";

  let { layout, i, h, w, merge = false, collapsed = false, head = 0 }: {
    layout: GraphLayout | null; i: number; h: number; w: number; merge?: boolean;
    /** dashed line in lane 0 from the changes row down to HEAD: 1 passes this row, 2 ends at this row's node */
    head?: number;
    /** a merge whose merged-in commits are hidden (Left): drawn with a plus */
    collapsed?: boolean;
  } = $props();

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
  {#if head > 0}<path d={head === 1 ? `M${x(0)} 0V${h}` : `M${x(0)} 0V${mid}`} stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="3 3" fill="none" />{/if}
  {#each paths as p}<path d={p.d} stroke="var(--lane{p.c})" stroke-width="2" fill="none" />{/each}
  {#if merge}
    <circle cx={nodeX} cy={mid} r={collapsed ? 5 : 3.5} fill="var(--surface)" stroke="var(--lane{nodeColor})" stroke-width="2" />
    {#if collapsed}<path class="plus" d="M{nodeX - 2.5} {mid}h5M{nodeX} {mid - 2.5}v5" stroke="var(--lane{nodeColor})" stroke-width="1.6" />{/if}
  {:else}
    <circle cx={nodeX} cy={mid} r="4" fill="var(--lane{nodeColor})" stroke="var(--surface)" stroke-width="1.5" />
  {/if}
</svg>
