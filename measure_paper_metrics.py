import asyncio
import datetime
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

print("=" * 70)
print(f"CONCARETTI PAPER METRICS VERIFICATION RUN")
print(f"Timestamp: {datetime.datetime.now(datetime.timezone.utc).isoformat()}")
print("=" * 70)

# 1. Cold import & app construction
t_start_import = time.perf_counter()
import main
from main import app
t_end_import = time.perf_counter()
cold_import_duration = t_end_import - t_start_import
print(f"[1] Cold Import & App Construction: {cold_import_duration:.3f} s (Paper Table 4: 2.37 s)")

# 2. Startup lifespan
async def measure_lifespan():
    t0 = time.perf_counter()
    async with app.router.lifespan_context(app):
        t_ready = time.perf_counter()
        print(f"[2] Startup to Serving (Lifespan): {(t_ready - t0):.3f} s (Paper Table 4: 0.08 s)")
        
        # 3. Policy status latency inside lifespan
        import httpx
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
            latencies = []
            for _ in range(10):
                t_req = time.perf_counter()
                res = await client.get("/api/conca/status")
                lat_ms = (time.perf_counter() - t_req) * 1000
                latencies.append(lat_ms)
            avg_lat = sum(latencies) / len(latencies)
            min_lat = min(latencies)
            print(f"[3] Policy Status Latency: {min_lat:.2f} ms (min), {avg_lat:.2f} ms (avg) (Paper Table 4: 12 ms)")

asyncio.run(measure_lifespan())

# 4. Database size
db_path = BACKEND / "concaretti.db"
if db_path.exists():
    sz = db_path.stat().st_size
    print(f"[4] Persistent Store on Disk: {sz:,} bytes ({sz / (1024*1024):.2f} MB) (Paper Table 4: 3.36 MB)")

print("=" * 70)
