export function ArrowIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="none">
      <path
        d="M4 10h10m0 0-4-4m4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon({ color }: { color: string }) {
  return (
    <svg
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 flex-none"
      viewBox="0 0 20 20"
      fill="none"
      style={{ color }}
    >
      <path
        d="m5 10.5 3 3L15.5 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
