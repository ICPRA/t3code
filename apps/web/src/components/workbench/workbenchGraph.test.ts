import { describe, expect, it } from "vite-plus/test";
import { compositionView, dependencyGraph, dependencyNeighbors, dependencyImpactRanking } from "@project-workbench/ui/graph";
import { validateWorkbenchSearch, type CurrentView } from "./workbenchModel";

const specs = [{ slug: "a", title: "Task A", stage: "specify", priority: "P1" }];
const nodes: CurrentView["graph"]["nodes"] = [
  { ...specs[0]!, label: "Spec" },
  { slug: "b", title: "Decision B", label: "Decision", stage: "recorded", priority: "" },
  { slug: "c", title: "Task C", label: "Spec", stage: "done", priority: "P2" },
];

describe("workbench dependency graph", () => {
  it("keeps directed mail links and their thread identity out of dependency counts and cycles", () => {
    const mail = { threads: [{ threadId: "mail-1", subject: "Review" }], messageCount: 2, pendingAckCount: 1 };
    const result = dependencyGraph({ nodes, edges: [
      { from: "a", to: "c", type: "BLOCKS" },
      { from: "c", to: "a", type: "MAIL", mail },
    ] }, specs);
    expect(result.cycleNodeIds).toEqual([]);
    expect(result.nodes.find((node) => node.id === "a")?.data.dependentCount).toBe(1);
    expect(result.nodes.find((node) => node.id === "a")?.data.prerequisiteCount).toBe(0);
    expect(result.edges[1]).toMatchObject({ source: "c", target: "a", data: { dependency: false, mail }, style: { strokeDasharray: "5 4" } });
    expect(validateWorkbenchSearch({ project: "p", tab: "collaboration", mailThread: "mail-1" })).toEqual({ project: "p", tab: "collaboration", mailThread: "mail-1" });
  });
  it("preserves explicit summary role separately from historical stage instead of inferring it from edges", () => {
    const result = dependencyGraph({ nodes, edges: [{ from: "a", to: "c", type: "COMPOSES" }] }, [
      ...specs, { slug: "c", title: "Task C", stage: "done", priority: "p2", role: "summary" },
    ]);
    expect(result.nodes.find((node) => node.id === "c")?.data).toMatchObject({ role: "summary", stage: "done", taskSlug: "c" });
    expect(result.nodes.find((node) => node.id === "a")?.data.role).toBeUndefined();
  });
  it("recognizes native Slice-to-Spec containment without reversing Spec submaps or rewriting stored edges", () => {
    const graph = { nodes: [
      { slug: "parent", title: "Parent", label: "Spec", stage: "approved", priority: "p2" },
      { slug: "child", title: "Child", label: "Spec", stage: "spark", priority: "p2" },
      { slug: "slice", title: "Native slice", label: "Slice", stage: "open", priority: "" },
    ], edges: [
      { from: "parent", to: "child", type: "COMPOSES" },
      { from: "slice", to: "parent", type: "COMPOSES" },
    ] };
    const original = structuredClone(graph);
    const view = compositionView(graph, "parent");
    expect(view.graph.nodes.map((node) => node.slug)).toEqual(["child", "slice"]);
    expect([...view.children.get("parent")!]).toEqual(["child", "slice"]);
    expect(view.children.has("slice")).toBe(false);
    expect(graph).toEqual(original);
  });

  it("opens immediate composition members and preserves actual external dependency endpoints", () => {
    const extra = ["parent", "child", "nested", "outside", "unrelated"].map((slug) => ({ slug, title: slug, label: "Spec", stage: "approved", priority: "p2" }));
    const graph = { nodes: extra, edges: [
      { from: "parent", to: "child", type: "COMPOSES" },
      { from: "child", to: "nested", type: "COMPOSES" },
      { from: "child", to: "outside", type: "DEPENDS_ON" },
      { from: "outside", to: "unrelated", type: "DEPENDS_ON" },
    ] };
    const before = structuredClone(graph);
    const result = compositionView(graph, "parent");
    expect(result.graph.nodes.map((node) => node.slug)).toEqual(["child", "outside"]);
    expect([...result.boundary]).toEqual(["outside"]);
    expect(result.graph.edges).toEqual([graph.edges[2]]);
    expect([...result.children.get("child")!]).toEqual(["nested"]);
    expect(compositionView(graph, "child").graph.nodes.map((node) => node.slug)).toEqual(["nested"]);
    expect(compositionView(graph, null).graph).toBe(graph);
    expect(graph).toEqual(before);
    const incomplete = compositionView({ ...graph, edges: [...graph.edges, { from: "parent", to: "missing", type: "COMPOSES" }] }, "parent");
    expect(incomplete.missingChildren).toEqual(["missing"]);
    expect(incomplete.graph.nodes.some((node) => node.slug === "missing")).toBe(false);
  });

  it("marks hard-dependency cycle members without treating association cycles as dependencies", () => {
    const result = dependencyGraph({ nodes, edges: [
      { from: "a", to: "b", type: "BLOCKS" },
      { from: "a", to: "b", type: "DEPENDS_ON" },
      { from: "b", to: "c", type: "RELATES_TO" },
      { from: "c", to: "a", type: "RELATES_TO" },
    ] }, specs);
    expect(result.error).toBeNull();
    expect(new Set(result.cycleNodeIds)).toEqual(new Set(["a", "b"]));
    expect(result.nodes.map((node) => node.data.inDependencyCycle)).toEqual([true, true, false]);
    const associations = dependencyGraph({ nodes, edges: [
      { from: "a", to: "b", type: "BLOCKS" },
      { from: "b", to: "a", type: "RELATES_TO" },
    ] }, specs);
    expect(associations.cycleNodeIds).toEqual([]);
  });

  it("detects self-dependency without rewriting the node business stage", () => {
    const result = dependencyGraph({ nodes, edges: [{ from: "c", to: "c", type: "DEPENDS_ON" }] }, specs);
    expect(result.error).toBeNull();
    expect(result.cycleNodeIds).toEqual(["c"]);
    expect(result.nodes.find((node) => node.id === "c")?.data.stage).toBe("done");
  });

  it("identifies only direct dependency neighbors, excluding associations and duplicates", () => {
    const graph = { nodes, edges: [
      { from: "a", to: "b", type: "DEPENDS_ON" },
      { from: "b", to: "a", type: "BLOCKS" },
      { from: "a", to: "c", type: "BLOCKS" },
      { from: "c", to: "b", type: "RELATES_TO" },
    ] };
    const result = dependencyNeighbors(graph, "a");
    expect([...result.prerequisites]).toEqual(["b"]);
    expect([...result.dependents]).toEqual(["c"]);
    const counts = dependencyGraph(graph, specs).nodes.map((node) => [node.id, node.data.prerequisiteCount, node.data.dependentCount]);
    expect(counts).toEqual([["a", 1, 1], ["b", 0, 1], ["c", 1, 0]]);
    expect(dependencyNeighbors(graph, null).prerequisites.size).toBe(0);
    expect(dependencyNeighbors(graph, "missing").dependents.size).toBe(0);
  });
  it("finds transitive downstream dependencies once through cycles, excluding associations and self", () => {
    const graph = { nodes: [...nodes, { ...nodes[0]!, slug: "unrelated" }], edges: [
      { from: "a", to: "b", type: "BLOCKS" },
      { from: "b", to: "a", type: "DEPENDS_ON" },
      { from: "c", to: "b", type: "DEPENDS_ON" },
      { from: "c", to: "a", type: "BLOCKS" },
      { from: "a", to: "unrelated", type: "COMPOSES" },
      { from: "b", to: "unrelated", type: "MAIL" },
    ] };
    expect([...dependencyNeighbors(graph, "a").downstream].sort()).toEqual(["b", "c"]);
    expect(dependencyNeighbors(graph, "unrelated").downstream.size).toBe(0);
    expect(dependencyNeighbors(graph, null).downstream.size).toBe(0);
    expect(dependencyNeighbors(graph, "missing").downstream.size).toBe(0);
    expect(dependencyImpactRanking(graph)).toEqual([
      { slug: "a", count: 2 }, { slug: "b", count: 2 }, { slug: "c", count: 2 }, { slug: "unrelated", count: 0 },
    ]);
    expect(dependencyImpactRanking({ nodes, edges: [
      { from: "a", to: "b", type: "BLOCKS" }, { from: "c", to: "b", type: "DEPENDS_ON" },
    ] })).toEqual([{ slug: "a", count: 2 }, { slug: "b", count: 1 }, { slug: "c", count: 0 }]);
  });
  it("lays out only returned nodes and normalizes both dependency directions", () => {
    const graph = {
      nodes,
      edges: [
        { from: "a", to: "b", type: "BLOCKS" },
        { from: "c", to: "b", type: "DEPENDS_ON" },
        { from: "a", to: "c", type: "RELATES_TO" },
      ],
    };
    const before = structuredClone(graph);
    const result = dependencyGraph(graph, specs);
    expect(result.error).toBeNull();
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(result.edges.map(({ source, target }) => [source, target])).toEqual([
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
    ]);
    expect(result.edges.every((edge) => edge.markerEnd)).toBe(true);
    expect(result.edges[2]?.style?.strokeDasharray).toBe("5 4");
    expect(
      result.nodes.every(
        ({ position }) => Number.isFinite(position.x) && Number.isFinite(position.y),
      ),
    ).toBe(true);
    expect(result.nodes[0]!.position.x).toBeLessThan(result.nodes[1]!.position.x);
    expect(graph).toEqual(before);
  });

  it("permits task navigation only for returned Specs, preserving full graph metadata", () => {
    const result = dependencyGraph({ nodes, edges: [] }, specs);
    expect(result.nodes.map((node) => node.data.taskSlug)).toEqual(["a", null, null]);
    expect(result.nodes[1]?.data.title).toBe("Decision B");
    expect(
      dependencyGraph({ nodes: [{ ...nodes[0]!, label: "Decision" }], edges: [] }, specs).nodes[0]
        ?.data.taskSlug,
    ).toBeNull();
    expect(
      validateWorkbenchSearch({ project: "p", tab: "tasks", layout: "graph", selected: "a" }),
    ).toEqual({ project: "p", tab: "tasks", layout: "graph", selected: "a" });
  });

  it("does not synthesize graph nodes from task records when the graph is empty", () => {
    expect(dependencyGraph({ nodes: [], edges: [] }, specs)).toEqual({
      nodes: [],
      edges: [],
      cycleNodeIds: [],
      error: null,
    });
  });

  it("reports missing endpoints and duplicate identifiers rather than drawing invented nodes", () => {
    const missing = dependencyGraph(
      { nodes, edges: [{ from: "a", to: "missing", type: "BLOCKS" }] },
      specs,
    );
    expect(missing.error).toContain("Missing graph endpoint");
    expect(missing.nodes).toEqual([]);
    expect(dependencyGraph({ nodes: [nodes[0]!, nodes[0]!], edges: [] }, specs).error).toContain(
      "Duplicate",
    );
  });
});
