from apps.realtime.ratelimit import TokenBucket


def test_bucket_allows_a_burst_then_refills():
    now = [0.0]
    bucket = TokenBucket(10, clock=lambda: now[0])
    assert [bucket.allow() for _ in range(10)] == [True] * 10
    assert bucket.allow() is False
    now[0] += 0.1  # one token
    assert bucket.allow() is True
    assert bucket.allow() is False
    now[0] += 60  # never more than one second's worth
    assert [bucket.allow() for _ in range(11)] == [True] * 10 + [False]
