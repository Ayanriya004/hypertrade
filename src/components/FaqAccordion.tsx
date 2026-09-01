import { useId, useState } from 'react';
import type { FaqItem } from '../lib/faq';

type Props = {
  items: FaqItem[];
};

export function FaqAccordion({ items }: Props) {
  const baseId = useId();
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="faq-list">
      {items.map((item) => {
        const open = openId === item.id;
        const panelId = `${baseId}-${item.id}-panel`;
        const btnId = `${baseId}-${item.id}-btn`;
        return (
          <div key={item.id} className={`faq-item${open ? ' open' : ''}`}>
            <h3 className="faq-item-heading">
              <button
                type="button"
                id={btnId}
                className="faq-trigger"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpenId(open ? null : item.id)}
              >
                <span className="faq-trigger-label">{item.title}</span>
                <span className="faq-chevron" aria-hidden>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M6 9l6 6 6-6"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={btnId}
              className="faq-panel"
              hidden={!open}
            >
              <p className="faq-body">{item.body}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
