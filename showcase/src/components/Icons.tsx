/** Small inline brand / UI icons for the showcase. */

type IconProps = {
  className?: string;
  size?: number;
};

export function ClockIcon({ className, size = 12 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 1.8" />
    </svg>
  );
}

export function GooglePlayIcon({ className, size = 16 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M3.6 2.3c-.4.2-.6.6-.6 1.1v17.2c0 .5.2.9.6 1.1l9.7-9.7L3.6 2.3zm12.1 7.1L13.2 12l2.5 2.6 3.5-2c.7-.4.7-1.4 0-1.8l-3.5-2zM4.8 21.7l8.1-8.1 2.5 2.5-9.3 5.3c-.5.3-1.1.2-1.3.3zm0-19.4c.2 0 .8-.1 1.3.3l9.3 5.3-2.5 2.5L4.8 2.3z"
      />
    </svg>
  );
}

export function MediumIcon({ className, size = 16 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M4.3 7.2a.7.7 0 0 0-.2-.6L2.4 4.3V4h6.1l4.7 10.3L17.4 4H23v.3l-1.6 1.5a.4.4 0 0 0-.2.4v11.5c0 .1 0 .3.2.4l1.6 1.5V20h-8.1v-.3l1.6-1.6c.2-.1.2-.2.2-.4V8.7l-5.2 11.3h-.7L4.8 8.7v7.6c0 .3.1.6.3.8l2.1 2.5V20H2v-.3l2.1-2.5c.2-.2.3-.5.2-.8V7.2z" />
    </svg>
  );
}

export function MailIcon({ className, size = 16 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}
