"""Run callables at the same instant, one thread and one DB connection each (PostgreSQL tests)."""

import threading
from concurrent.futures import ThreadPoolExecutor

from django.db import connection

RESULT_TIMEOUT_SECONDS = 90


def run_parallel(jobs, workers=None):
    """Returns [(ok, result_or_exception)] in job order. A hung pool is abandoned, not joined
    (the test settings' lock_timeout / statement_timeout end the stuck statements)."""
    workers = workers or len(jobs)
    barrier = threading.Barrier(len(jobs))

    def wrap(job):
        def run():
            try:
                barrier.wait(timeout=30)
                return True, job()
            except BaseException as exc:  # noqa: BLE001 - reported to the assertions
                return False, exc
            finally:
                connection.close()

        return run

    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = [pool.submit(wrap(job)) for job in jobs]
        return [f.result(timeout=RESULT_TIMEOUT_SECONDS) for f in futures]
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
