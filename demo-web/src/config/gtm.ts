// lib/gtm.ts

export type EventParams = {
  action: string;
  category: string;
  label?: string;
  value?: string | number;
  [key: string]: any;
};

declare global {
  interface Window {
    dataLayer: any[];
  }
}

export const GTM_ID = 'GTM-PQLGML9K';

export const pageview = (url: string) => {
  if (typeof window.dataLayer !== 'undefined') {
    window.dataLayer.push({
      event: 'pageview',
      page: url,
    });
  } else {
    console.log(
      'GTM not loaded yet. Pageview not tracked '
    );
  }
};

export const event = ({ action, category, label, value, ...rest }: EventParams) => {
  if (typeof window.dataLayer !== 'undefined') {
    window.dataLayer.push({
      event: 'event',
      eventCategory: category,
      eventAction: action,
      eventLabel: label,
      eventValue: value,
      ...rest,
    });
  } else {
    console.log(
      'GTM not loaded yet. Event not tracked'
    );
  }
};

// Tipos comuns de eventos para reutilização
export const GTM_EVENTS = {
  CLICK: 'click',
  SUBMIT: 'submit',
  SCROLL: 'scroll',
  HOVER: 'hover',
  DOWNLOAD: 'file_download',
} as const;

export const GTM_CATEGORIES = {
  BUTTON: 'button',
  FORM: 'form',
  LINK: 'link',
  NAVIGATION: 'navigation',
  USER: 'user',
  SYSTEM: 'system',
} as const;
