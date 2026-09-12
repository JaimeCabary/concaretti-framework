import { useEffect, useState } from "react";
import { Joyride, STATUS, type Step, type EventData } from "react-joyride";

const TOUR_STORAGE_KEY = "conca_tour_completed";

export function TutorialTour() {
  const [run, setRun] = useState(false);

  useEffect(() => {
    // Check if user just finished onboarding or explicitly triggered tutorial
    const pendingTour = localStorage.getItem("conca_start_tutorial");
    const completedTour = localStorage.getItem(TOUR_STORAGE_KEY);

    if (pendingTour === "1" || (!completedTour && pendingTour !== "0")) {
      const timer = setTimeout(() => {
        setRun(true);
      }, 1000);
      return () => clearTimeout(timer);
    }

    const handleCustomTrigger = () => {
      setRun(true);
    };
    window.addEventListener("conca_start_tutorial", handleCustomTrigger);
    return () => window.removeEventListener("conca_start_tutorial", handleCustomTrigger);
  }, []);

  const steps: Step[] = [
    {
      target: '[data-tour="cockpit"]',
      title: "Council Command Cockpit",
      content:
        "The central nervous system of Concaretti. Direct 15 specialized agents concurrently with natural language, file attachments, or voice dictation.",
      skipBeacon: true,
      placement: "bottom",
    },
    {
      target: '[data-tour="tab-calendar"]',
      title: "Calendar & Schedule Agent",
      content:
        "Inspect timelines, synchronize Google Calendar events, and coordinate schedules with real-time pulsing skeleton updates.",
      skipBeacon: true,
      placement: "right",
    },
    {
      target: '[data-tour="tab-email"]',
      title: "Live Email Hub",
      content:
        "Instant inbox fetching, automated classification, and human-in-the-loop draft confirmations via HALO safety gates.",
      skipBeacon: true,
      placement: "right",
    },
    {
      target: '[data-tour="tab-policy"]',
      title: ".conca Safety Rules & Grants",
      content:
        "Inspect deterministic rules, verify cryptographic gates, and review active tool permissions granted to each agent.",
      skipBeacon: true,
      placement: "right",
    },
    {
      target: '[data-tour="profile-role"]',
      title: "Role & Authority Switcher",
      content:
        "Easily switch roles between Staff (full council ops), Student (curriculum & tools), and Public guest access.",
      skipBeacon: true,
      placement: "top",
    },
  ];

  const handleJoyrideEvent = (data: EventData) => {
    const { status } = data;
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      setRun(false);
      localStorage.setItem(TOUR_STORAGE_KEY, "1");
      localStorage.removeItem("conca_start_tutorial");
    }
  };

  return (
    <Joyride
      steps={steps}
      run={run}
      onEvent={handleJoyrideEvent}
      locale={{ last: "Next" }}
      options={{
        arrowColor: "#18181B",
        backgroundColor: "#18181B",
        overlayColor: "rgba(10, 10, 12, 0.65)",
        primaryColor: "#00E5FF",
        textColor: "#F4F4F5",
        showProgress: true,
        zIndex: 10000,
      }}
      styles={{
        tooltip: {
          borderRadius: "14px",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          padding: "18px",
          boxShadow: "0 16px 36px rgba(0, 0, 0, 0.45)",
          fontSize: "13px",
          lineHeight: "1.6",
        },
        tooltipTitle: {
          fontSize: "15px",
          fontWeight: 700,
          color: "#FFFFFF",
          marginBottom: "8px",
          letterSpacing: "-0.01em",
        },
        tooltipContent: {
          padding: "4px 0 12px",
          color: "#A1A1AA",
        },
        buttonPrimary: {
          backgroundColor: "#00E5FF",
          color: "#09090B",
          fontWeight: 600,
          fontSize: "12px",
          borderRadius: "8px",
          padding: "7px 14px",
          cursor: "pointer",
        },
        buttonBack: {
          color: "#A1A1AA",
          fontSize: "12px",
          marginRight: "8px",
        },
        buttonSkip: {
          color: "#71717A",
          fontSize: "12px",
        },
      }}
    />
  );
}
