"""A fake `databricks.sql` (the SQL Connector for Python) backed by the fake warehouse."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakedbx import engine  # noqa: E402


class Error(Exception):
    pass


class Cursor:
    def __init__(self):
        self.description = None
        self._rows = []

    def execute(self, operation, parameters=None):
        answer = engine.execute(operation, "Databricks SQL Connector for Python")
        if answer["status"]["state"] == "FAILED":
            raise Error(answer["status"]["error"]["message"])
        cols = answer["manifest"]["schema"]["columns"]
        self.description = [(c["name"],) for c in cols]
        self._rows = [tuple(r) for r in answer["result"]["data_array"]]
        return self

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class Connection:
    def cursor(self):
        return Cursor()

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def connect(**_kwargs):
    return Connection()
