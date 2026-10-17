"""A* shortest path (ARCHITECTURE 10.2) as a small, dependency-free, unit-tested library.

Status: NOT wired into the request path yet. There is no road graph loader (OSM) at this stage;
`routing.services` falls back to a straight line when OSRM is down. This module is the algorithm
that a future small-area graph fallback will call.

Graph: ``{node: [(neighbour, weight), ...]}`` (directed; weights are travel times in seconds,
finite and >= 0). Every node that has to be a start or goal must be a key of the mapping; edge
targets without an entry simply have no outgoing edges.

Optimality needs an admissible heuristic (never above the true remaining cost). Reopening nodes
on every improvement keeps A* optimal for admissible-but-inconsistent heuristics too.
"""

import heapq
import itertools
import math
from collections.abc import Callable, Hashable, Mapping

from apps.core.geomath import haversine_m

Node = Hashable
Heuristic = Callable[[Node], float]


def _valid_number(value) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def reconstruct(parent: Mapping[Node, Node | None], goal: Node) -> list[Node]:
    """Walk the parent links from `goal` back to the start; returns start..goal."""
    path = [goal]
    seen = {goal}
    node = parent[goal]
    while node is not None:
        if node in seen:
            raise ValueError("cycle in parent links")
        seen.add(node)
        path.append(node)
        node = parent[node]
    path.reverse()
    return path


def haversine_heuristic(
    coords: Mapping[Node, tuple[float, float]], goal: Node, v_max_mps: float
) -> Heuristic:
    """h(n) = haversine(n, goal) / v_max (seconds). Admissible when no edge is faster than v_max.

    `coords` maps node -> ``(lat, lng)`` in degrees (latitude FIRST, unlike GeoJSON); edge
    weights must be travel times in seconds and `v_max_mps` the top speed in metres per second.
    """
    if not _valid_number(v_max_mps) or v_max_mps == 0:
        raise ValueError("v_max must be a positive finite number (m/s)")
    if goal not in coords:
        raise ValueError("goal has no coordinates")
    goal_lat, goal_lng = coords[goal]

    def h(node: Node) -> float:
        if node not in coords:
            raise ValueError("node has no coordinates")
        lat, lng = coords[node]
        return haversine_m(lat, lng, goal_lat, goal_lng) / v_max_mps

    return h


def a_star(
    graph: Mapping[Node, list[tuple[Node, float]]], start: Node, goal: Node, h: Heuristic
) -> tuple[list[Node] | None, float]:
    """Cheapest path start -> goal as ``(nodes, cost)``; ``(None, inf)`` when unreachable.

    Raises ValueError for a non-mapping graph, a non-callable `h`, unknown start/goal, a
    negative/non-finite edge weight or a negative/non-finite heuristic value.
    """
    if not isinstance(graph, Mapping):
        raise ValueError("graph must be a mapping")
    if not callable(h):
        raise ValueError("heuristic must be callable")
    try:
        known = start in graph and goal in graph
    except TypeError:  # unhashable start/goal
        raise ValueError("start and goal must be hashable nodes of the graph") from None
    if not known:
        raise ValueError("start and goal must be nodes of the graph")

    def estimate(node: Node) -> float:
        value = h(node)
        if not _valid_number(value):
            raise ValueError("heuristic must return a finite number >= 0")
        return value

    tie = itertools.count()  # nodes need not be orderable
    open_heap = [(estimate(start), next(tie), 0, start)]
    g: dict[Node, float] = {start: 0}
    parent: dict[Node, Node | None] = {start: None}
    while open_heap:
        _, _, cost, node = heapq.heappop(open_heap)
        if node == goal:
            return reconstruct(parent, goal), cost
        if cost > g[node]:
            continue  # stale entry: a cheaper way to `node` was found after this was pushed
        for nxt, weight in graph.get(node, ()):
            if not _valid_number(weight):
                raise ValueError("edge weights must be finite numbers >= 0")
            new_cost = cost + weight
            if new_cost < g.get(nxt, math.inf):
                g[nxt] = new_cost
                parent[nxt] = node
                heapq.heappush(open_heap, (new_cost + estimate(nxt), next(tie), new_cost, nxt))
    return None, math.inf
