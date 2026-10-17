"""A* (ARCHITECTURE 10.2): optimality against Dijkstra, admissible heuristics, edge cases."""

import heapq
import math
import random

import pytest

from apps.core.geomath import haversine_m
from apps.routing.astar import a_star, haversine_heuristic, reconstruct


def dijkstra(graph, start, goal):
    """Reference implementation used as the oracle."""
    best = {start: 0.0}
    heap = [(0.0, 0, start)]
    tick = 0
    while heap:
        cost, _, node = heapq.heappop(heap)
        if node == goal:
            return cost
        if cost > best.get(node, math.inf):
            continue
        for nxt, w in graph.get(node, ()):
            new = cost + w
            if new < best.get(nxt, math.inf):
                best[nxt] = new
                tick += 1
                heapq.heappush(heap, (new, tick, nxt))
    return math.inf


def random_graph(rng, n=40, edges=140):
    graph = {i: [] for i in range(n)}
    for _ in range(edges):
        a, b = rng.randrange(n), rng.randrange(n)
        graph[a].append((b, rng.choice([0, 0.5, 1, 2, 7.25, 30])))
    return graph


def path_cost(graph, path):
    total = 0.0
    for a, b in zip(path, path[1:], strict=False):
        total += min(w for nxt, w in graph[a] if nxt == b)
    return total


class TestAgainstDijkstra:
    def test_zero_heuristic_matches_dijkstra_on_random_graphs(self):
        rng = random.Random(1234)  # noqa: S311
        for _ in range(150):
            graph = random_graph(rng)
            start, goal = rng.randrange(40), rng.randrange(40)
            path, cost = a_star(graph, start, goal, lambda n: 0)
            expected = dijkstra(graph, start, goal)
            if math.isinf(expected):
                assert path is None and math.isinf(cost)
            else:
                assert cost == pytest.approx(expected)
                assert path[0] == start and path[-1] == goal
                assert path_cost(graph, path) == pytest.approx(cost)

    def test_admissible_inconsistent_heuristic_is_still_optimal(self):
        rng = random.Random(99)  # noqa: S311
        for _ in range(100):
            graph = random_graph(rng)
            start, goal = rng.randrange(40), rng.randrange(40)
            # true remaining cost scaled by a random factor in [0, 1]: admissible, inconsistent
            h_values = {}
            for node in graph:
                true_cost = dijkstra(graph, node, goal)
                h_values[node] = 0 if math.isinf(true_cost) else rng.random() * true_cost
            path, cost = a_star(graph, start, goal, h_values.__getitem__)
            expected = dijkstra(graph, start, goal)
            if math.isinf(expected):
                assert path is None
            else:
                assert cost == pytest.approx(expected)

    def test_geometric_graph_with_haversine_heuristic_is_optimal(self):
        rng = random.Random(7)  # noqa: S311
        coords = {i: (41.2 + rng.random() * 0.2, 69.1 + rng.random() * 0.2) for i in range(60)}
        v_max = 25.0  # m/s
        graph = {i: [] for i in coords}
        for _ in range(240):
            a, b = rng.randrange(60), rng.randrange(60)
            meters = haversine_m(*coords[a], *coords[b])
            speed = rng.uniform(5, v_max)  # never faster than v_max -> heuristic admissible
            graph[a].append((b, meters / speed))
        for _ in range(30):
            start, goal = rng.randrange(60), rng.randrange(60)
            h = haversine_heuristic(coords, goal, v_max)
            path, cost = a_star(graph, start, goal, h)
            expected = dijkstra(graph, start, goal)
            if math.isinf(expected):
                assert path is None
            else:
                assert cost == pytest.approx(expected)


class TestKnownCases:
    def test_prefers_cheaper_longer_path(self):
        graph = {"a": [("b", 10), ("c", 1)], "b": [("d", 1)], "c": [("b", 2)], "d": []}
        assert a_star(graph, "a", "d", lambda n: 0) == (["a", "c", "b", "d"], 4)

    def test_no_path_returns_none_and_infinity(self):
        graph = {"a": [("b", 1)], "b": [], "z": []}
        path, cost = a_star(graph, "a", "z", lambda n: 0)
        assert path is None and cost == math.inf

    def test_single_node_start_equals_goal(self):
        assert a_star({"a": []}, "a", "a", lambda n: 0) == (["a"], 0)

    def test_directed_edges_are_respected(self):
        graph = {"a": [], "b": [("a", 1)]}
        assert a_star(graph, "a", "b", lambda n: 0)[0] is None

    def test_zero_weight_cycle_terminates(self):
        graph = {"a": [("b", 0)], "b": [("a", 0), ("c", 1)], "c": []}
        assert a_star(graph, "a", "c", lambda n: 0) == (["a", "b", "c"], 1)

    def test_stale_heap_entries_are_skipped(self):
        graph = {"a": [("b", 10), ("c", 1)], "c": [("b", 1)], "b": [("t", 1)], "t": []}
        assert a_star(graph, "a", "t", lambda n: 0) == (["a", "c", "b", "t"], 3)

    def test_unorderable_node_types_work(self):
        a, b = object(), object()
        graph = {a: [(b, 1)], b: []}
        assert a_star(graph, a, b, lambda n: 0) == ([a, b], 1)

    def test_edge_to_node_without_adjacency_entry_is_allowed(self):
        graph = {"a": [("b", 2)], "b": []}
        assert a_star(graph, "a", "b", lambda n: 0) == (["a", "b"], 2)

    def test_long_chain(self):
        n = 10_000
        graph = {i: [(i + 1, 1)] for i in range(n)}
        graph[n] = []
        path, cost = a_star(graph, 0, n, lambda i: n - i)
        assert cost == n and len(path) == n + 1


class TestInvalidInput:
    def test_unknown_start_raises(self):
        with pytest.raises(ValueError):
            a_star({"a": []}, "x", "a", lambda n: 0)

    def test_unhashable_start_or_goal_raises_value_error(self):
        with pytest.raises(ValueError):
            a_star({"a": []}, ["a"], "a", lambda n: 0)
        with pytest.raises(ValueError):
            a_star({"a": []}, "a", {"x": 1}, lambda n: 0)

    def test_unknown_goal_raises(self):
        with pytest.raises(ValueError):
            a_star({"a": []}, "a", "x", lambda n: 0)

    @pytest.mark.parametrize("weight", [-1, float("nan"), float("-inf"), float("inf"), "x", None])
    def test_bad_edge_weight_raises(self, weight):
        with pytest.raises(ValueError):
            a_star({"a": [("b", weight)], "b": []}, "a", "b", lambda n: 0)

    def test_bool_weight_rejected(self):
        with pytest.raises(ValueError):
            a_star({"a": [("b", True)], "b": []}, "a", "b", lambda n: 0)

    @pytest.mark.parametrize("value", [-1.0, float("nan"), "x", None])
    def test_bad_heuristic_value_raises(self, value):
        with pytest.raises(ValueError):
            a_star({"a": [("b", 1)], "b": []}, "a", "b", lambda n: value)

    def test_non_mapping_graph_raises(self):
        with pytest.raises(ValueError):
            a_star([("a", "b")], "a", "b", lambda n: 0)

    def test_non_callable_heuristic_raises(self):
        with pytest.raises(ValueError):
            a_star({"a": []}, "a", "a", None)


class TestReconstruct:
    def test_walks_parents_back(self):
        assert reconstruct({"a": None, "b": "a", "c": "b"}, "c") == ["a", "b", "c"]

    def test_cycle_in_parents_is_detected(self):
        with pytest.raises(ValueError):
            reconstruct({"a": "b", "b": "a"}, "a")


class TestHaversineHeuristic:
    def test_zero_at_goal_and_scaled_by_speed(self):
        coords = {"a": (41.0, 69.0), "b": (41.0, 69.01)}
        h = haversine_heuristic(coords, "b", 10.0)
        assert h("b") == 0
        assert h("a") == pytest.approx(839.0 / 10.0, rel=0.02)

    @pytest.mark.parametrize("speed", [0, -3, float("nan"), float("inf")])
    def test_bad_speed_rejected(self, speed):
        with pytest.raises(ValueError):
            haversine_heuristic({"a": (0, 0)}, "a", speed)

    def test_unknown_goal_rejected(self):
        with pytest.raises(ValueError):
            haversine_heuristic({"a": (0, 0)}, "zzz", 10)

    def test_unknown_node_raises_value_error(self):
        h = haversine_heuristic({"a": (0, 0)}, "a", 10)
        with pytest.raises(ValueError):
            h("nope")
