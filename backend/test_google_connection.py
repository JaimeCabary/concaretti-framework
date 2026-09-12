import os
from dotenv import load_dotenv

# Load .env into os.environ before importing tools
load_dotenv(".env")

from tools import _google_service

def test_connection():
    print("Testing Google Workspace Connection...\n")
    
    gmail_service = _google_service("gmail", "v1")
    if gmail_service:
        try:
            profile = gmail_service.users().getProfile(userId="me").execute()
            print(f"[+] Gmail Connected! Authenticated as: {profile.get('emailAddress')}")
        except Exception as e:
            print(f"[-] Gmail API error: {e}")
    else:
        print("[-] Failed to initialize Gmail service. Check your .env credentials.")
        
    calendar_service = _google_service("calendar", "v3")
    if calendar_service:
        try:
            calendar_list = calendar_service.calendarList().list().execute()
            print(f"[+] Calendar Connected! Found {len(calendar_list.get('items', []))} calendars.")
        except Exception as e:
            print(f"[-] Calendar API error: {e}")
    else:
        print("[-] Failed to initialize Calendar service. Check your .env credentials.")

if __name__ == "__main__":
    test_connection()
