import os
import time
from datetime import datetime, timezone
from memory import Store
from tools import _google_service

def sync_google_calendar():
    print("[*] Starting Google Calendar Sync...")
    service = _google_service("calendar", "v3")
    if service is None:
        print("[!] Google Calendar is not connected. Please connect it first.")
        return

    # Fetch events from the last 30 days up to 1 year in the future
    now_ts = time.time()
    time_min = datetime.fromtimestamp(now_ts - (30 * 86_400), tz=timezone.utc).isoformat()
    time_max = datetime.fromtimestamp(now_ts + (365 * 86_400), tz=timezone.utc).isoformat()

    try:
        events_result = (
            service.events()
            .list(
                calendarId="primary",
                timeMin=time_min,
                timeMax=time_max,
                maxResults=2500,
                singleEvents=True,
                orderBy="startTime",
            )
            .execute()
        )
        events = events_result.get("items", [])
        
        if not events:
            print("[*] No events found on Google Calendar.")
            return

        print(f"[*] Found {len(events)} events on Google Calendar. Syncing to local db...")
        store = Store("concaretti.db")
        
        synced_count = 0
        for e in events:
            # Parse start and end times
            start = e.get("start", {})
            end = e.get("end", {})
            
            start_str = start.get("dateTime") or start.get("date")
            end_str = end.get("dateTime") or end.get("date")
            
            if not start_str:
                continue
                
            try:
                # Handle ISO formatting nicely
                if "T" in start_str:
                    start_ts = datetime.fromisoformat(start_str.replace("Z", "+00:00")).timestamp()
                else:
                    # All day event
                    start_ts = datetime.fromisoformat(f"{start_str}T00:00:00+00:00").timestamp()
                    
                if end_str:
                    if "T" in end_str:
                        end_ts = datetime.fromisoformat(end_str.replace("Z", "+00:00")).timestamp()
                    else:
                        end_ts = datetime.fromisoformat(f"{end_str}T00:00:00+00:00").timestamp()
                else:
                    end_ts = start_ts + 3600 # 1 hour default if missing end
            except Exception as parse_err:
                print(f"[!] Skipping event {e.get('summary', 'Unknown')} due to time parsing error: {parse_err}")
                continue
                
            # Upsert logic - store.create_event currently inserts, we need to make sure we don't duplicate
            # The store uses an auto-incrementing ID. Since it's a simple sync, we'll just insert if it's not already there.
            # We check by querying the range and title.
            existing = store.list_events(start_ts - 10, end_ts + 10)
            if any(ex["title"] == e.get("summary", "Untitled") for ex in existing):
                continue # Already exists
            
            store.create_event(
                title=e.get("summary", "Untitled"),
                start_ts=start_ts,
                end_ts=end_ts,
                kind=e.get("eventType", "event"),
                synced=True
            )
            synced_count += 1

        print(f"[+] Successfully synced {synced_count} new events to local database.")
        
    except Exception as err:
        print(f"[!] Error fetching events from Google Calendar: {err}")

if __name__ == "__main__":
    # Ensure working directory is backend for concaretti.db
    if not os.path.exists("concaretti.db") and os.path.exists("backend/concaretti.db"):
        os.chdir("backend")
    sync_google_calendar()
