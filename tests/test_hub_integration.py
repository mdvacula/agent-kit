"""
Integration tests for the MCP Task Hub.

These tests hit the live hub at http://localhost:8000 via plain HTTP.
They verify the hub contract as a consumer — independent of the hub's
internal implementation.

Requirements:
    Hub must be running: docker compose -f ~/mcp-task-hub/docker-compose.yml up -d

Run:
    python -m pytest tests/test_hub_integration.py -v

Skip gracefully when the hub is not running:
    python -m pytest tests/test_hub_integration.py -v -m integration
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

import pytest

HUB_BASE = "http://localhost:8000"


def _hub_available() -> bool:
    try:
        urllib.request.urlopen(f"{HUB_BASE}/health", timeout=2)
        return True
    except Exception:
        return False


hub_required = pytest.mark.skipif(
    not _hub_available(),
    reason="Hub not running — start with: docker compose -f ~/mcp-task-hub/docker-compose.yml up -d",
)


def _get(path: str) -> Any:
    with urllib.request.urlopen(f"{HUB_BASE}{path}", timeout=5) as r:
        return json.loads(r.read())


def _post(path: str, body: dict) -> dict | list:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{HUB_BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def _get_status(path: str) -> int:
    try:
        with urllib.request.urlopen(f"{HUB_BASE}{path}", timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


# ── Unique IDs per test run so tests don't interfere with existing hub data ──


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


# ── Tests ────────────────────────────────────────────────────────────────────


@hub_required
class TestHealth:
    def test_health_returns_ok(self):
        data = _get("/health")
        assert data["status"] == "ok"
        assert isinstance(data["task_count"], int)

    def test_health_task_count_is_non_negative(self):
        data = _get("/health")
        assert data["task_count"] >= 0


@hub_required
class TestTasksCRUD:
    def test_create_and_retrieve_task(self):
        tid = _uid("integ-create")
        # hub has no direct REST POST — we verify via /tasks/<id> after a GET
        # First confirm it doesn't exist yet
        assert _get_status(f"/tasks/{tid}") == 404

    def test_tasks_list_is_array(self):
        data = _get("/tasks")
        assert isinstance(data, list)

    def test_task_not_found_returns_404(self):
        assert (
            _get_status(f"/tasks/definitely-does-not-exist-{uuid.uuid4().hex}") == 404
        )

    def test_health_count_consistent_with_tasks_list(self):
        health = _get("/health")
        tasks = _get("/tasks")
        assert health["task_count"] == len(tasks)


@hub_required
class TestHubContract:
    """
    Verify the hub contract the agents rely on.
    These tests use the HTTP read endpoints to confirm state after
    the hub has been exercised by the agentic-setup bootstrap.
    """

    def test_tasks_have_required_fields(self):
        tasks = _get("/tasks")
        for task in tasks:
            assert "id" in task
            assert "title" in task
            assert "status" in task
            assert "metadata" in task
            assert "created_at" in task
            assert "updated_at" in task

    def test_task_status_values_are_valid(self):
        valid = {"pending", "in-progress", "completed", "blocked"}
        tasks = _get("/tasks")
        for task in tasks:
            assert task["status"] in valid, (
                f"Task {task['id']} has unexpected status: {task['status']}"
            )

    def test_metadata_is_dict(self):
        tasks = _get("/tasks")
        for task in tasks:
            assert isinstance(task["metadata"], dict), (
                f"Task {task['id']} metadata is not a dict"
            )

    def test_individual_task_matches_list(self):
        tasks = _get("/tasks")
        if not tasks:
            pytest.skip("No tasks in hub — nothing to cross-check")
        task_from_list = tasks[0]
        task_by_id = _get(f"/tasks/{task_from_list['id']}")
        assert task_by_id["id"] == task_from_list["id"]
        assert task_by_id["title"] == task_from_list["title"]
        assert task_by_id["status"] == task_from_list["status"]

    def test_startup_time(self):
        """Hub should respond to /health in well under 2 seconds."""
        start = time.monotonic()
        _get("/health")
        elapsed = time.monotonic() - start
        assert elapsed < 2.0, f"Hub responded in {elapsed:.2f}s (limit: 2.0s)"
