export const REPO_HEADER_ACTION_REVEAL_CLASS =
  'min-w-0 max-w-0 -ml-1.5 overflow-hidden opacity-0 focus:ml-0 focus:max-w-5 focus:opacity-100 group-hover:ml-0 group-hover:max-w-5 group-hover:opacity-100'

// Why: ring-inset keeps the 3px focus ring inside the button box; the h-6 header row is
// overflow-hidden with only 2px clearance around these size-5 buttons, so an outset ring clips.
export const REPO_HEADER_ACTION_BUTTON_CLASS = `size-5 shrink-0 ${REPO_HEADER_ACTION_REVEAL_CLASS} rounded-md focus-visible:ring-inset text-muted-foreground transition-[margin,max-width,opacity,background-color,color] hover:bg-accent/70 hover:text-foreground data-[state=open]:ml-0 data-[state=open]:max-w-5 data-[state=open]:opacity-100`
