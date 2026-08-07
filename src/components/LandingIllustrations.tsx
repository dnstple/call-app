/**
 * Flat, warm landing illustrations (peach / sage / cream) — no photography.
 * Reusable SVG people-on-the-phone scenes matching the Apricoti ad style.
 * Decorative only: aria-hidden, no text changes.
 */
const C = {
  peachCircle: '#F7DCC9',
  mintCircle: '#DDEBE1',
  skin: '#ECC3A0',
  skinLight: '#F3D2B4',
  hairGrey: '#C7C1B8',
  hairDark: '#2F2A27',
  green: '#6E8E74',
  greenDeep: '#5C8266',
  peachTop: '#E68E5B',
  phone: '#2F2A27',
  cheek: '#EDA183',
  heart: '#E8825A',
  star: '#F0A878',
  line: '#2F2A27',
};

function Star({ x, y, s = 1, color = C.star }: { x: number; y: number; s?: number; color?: string }) {
  const a = 9 * s;
  return (
    <path
      d={`M ${x} ${y - a} C ${x + 1.5} ${y - 2} ${x + 2} ${y - 1.5} ${x + a} ${y} C ${x + 2} ${y + 1.5} ${x + 1.5} ${y + 2} ${x} ${y + a} C ${x - 1.5} ${y + 2} ${x - 2} ${y + 1.5} ${x - a} ${y} C ${x - 2} ${y - 1.5} ${x - 1.5} ${y - 2} ${x} ${y - a} Z`}
      fill={color}
    />
  );
}

function Wifi({ x, y, flip = false, color = C.greenDeep }: { x: number; y: number; flip?: boolean; color?: string }) {
  const d = flip ? -1 : 1;
  return (
    <g stroke={color} strokeWidth="3.5" fill="none" strokeLinecap="round">
      <path d={`M ${x} ${y} q ${9 * d} -9 ${18 * d} 0`} />
      <path d={`M ${x - 5 * d} ${y + 6} q ${14 * d} -15 ${28 * d} 0`} />
    </g>
  );
}

/** One person in a coloured circle, phone to the ear. */
function Person({
  id, cx, cy = 108, r = 78, bg, hair, top, glassesColor, phoneRight = false,
}: {
  id: string; cx: number; cy?: number; r?: number; bg: string;
  hair: 'greyBun' | 'darkBun' | 'greyShort'; top: string; glassesColor?: string; phoneRight?: boolean;
}) {
  const clip = `clip-${id}`;
  const headY = cy - 20;
  const dir = phoneRight ? 1 : -1;
  const ex = 11; // eye offset
  return (
    <g>
      <clipPath id={clip}><circle cx={cx} cy={cy} r={r} /></clipPath>
      <circle cx={cx} cy={cy} r={r} fill={bg} />
      <g clipPath={`url(#${clip})`}>
        {/* body / shoulders */}
        <path
          d={`M ${cx - 62} ${cy + r} V ${cy + 18} C ${cx - 62} ${cy - 8} ${cx - 30} ${cy - 18} ${cx} ${cy - 18} C ${cx + 30} ${cy - 18} ${cx + 62} ${cy - 8} ${cx + 62} ${cy + 18} V ${cy + r} Z`}
          fill={top}
        />
        {/* neck */}
        <rect x={cx - 12} y={headY + 18} width="24" height="22" rx="10" fill={C.skinLight} />
        {/* head */}
        <circle cx={cx} cy={headY} r="33" fill={C.skin} />
        {/* hair */}
        {hair === 'greyBun' && (
          <>
            <path d={`M ${cx - 33} ${headY - 2} C ${cx - 33} ${headY - 34} ${cx + 33} ${headY - 34} ${cx + 33} ${headY - 2} C ${cx + 20} ${headY - 20} ${cx - 20} ${headY - 20} ${cx - 33} ${headY - 2} Z`} fill={C.hairGrey} />
            <circle cx={cx} cy={headY - 34} r="12" fill={C.hairGrey} />
          </>
        )}
        {hair === 'darkBun' && (
          <>
            <path d={`M ${cx - 33} ${headY - 2} C ${cx - 33} ${headY - 34} ${cx + 33} ${headY - 34} ${cx + 33} ${headY - 2} C ${cx + 20} ${headY - 20} ${cx - 20} ${headY - 20} ${cx - 33} ${headY - 2} Z`} fill={C.hairDark} />
            <circle cx={cx + 24} cy={headY - 30} r="11" fill={C.hairDark} />
          </>
        )}
        {hair === 'greyShort' && (
          <path d={`M ${cx - 34} ${headY + 4} C ${cx - 36} ${headY - 36} ${cx + 36} ${headY - 36} ${cx + 34} ${headY + 4} C ${cx + 22} ${headY - 14} ${cx - 22} ${headY - 14} ${cx - 34} ${headY + 4} Z`} fill={C.hairGrey} />
        )}
      </g>
      {/* eyes (happy closed arcs) */}
      <path d={`M ${cx - ex - 6} ${headY + 2} q 6 6 12 0`} stroke={C.line} strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d={`M ${cx + ex - 6} ${headY + 2} q 6 6 12 0`} stroke={C.line} strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* glasses (optional) */}
      {glassesColor && (
        <g stroke={glassesColor} strokeWidth="2.5" fill="none">
          <circle cx={cx - ex} cy={headY + 2} r="9" />
          <circle cx={cx + ex} cy={headY + 2} r="9" />
          <path d={`M ${cx - ex + 9} ${headY + 2} h ${2 * ex - 18}`} />
        </g>
      )}
      {/* cheeks */}
      <circle cx={cx - 18} cy={headY + 12} r="5" fill={C.cheek} opacity="0.75" />
      <circle cx={cx + 18} cy={headY + 12} r="5" fill={C.cheek} opacity="0.75" />
      {/* smile */}
      <path d={`M ${cx - 8} ${headY + 15} q 8 8 16 0`} stroke={C.line} strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* arm + phone at the ear */}
      <g transform={`translate(${cx + dir * 30} ${headY + 6}) rotate(${dir * 12})`}>
        <rect x="-8" y="-20" width="16" height="42" rx="7" fill={C.phone} />
        <rect x="-4.5" y="-15" width="9" height="26" rx="3" fill="#4a4441" />
      </g>
      <path
        d={`M ${cx + dir * 20} ${cy + 30} C ${cx + dir * 40} ${cy + 22} ${cx + dir * 44} ${headY + 24} ${cx + dir * 34} ${headY + 10} C ${cx + dir * 30} ${headY + 4} ${cx + dir * 24} ${headY + 10} ${cx + dir * 22} ${cy + 20} Z`}
        fill={C.skin}
      />
    </g>
  );
}

/** Hero: two people on the phone with a heart between them. */
export function TwoPeopleTalking({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 440 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
      <Person id="left" cx={120} cy={140} r={82} bg={C.mintCircle} hair="darkBun" top={C.peachTop} phoneRight />
      <Person id="right" cx={320} cy={140} r={82} bg={C.peachCircle} hair="greyBun" top={C.green} glassesColor={C.line} />
      {/* heart between them */}
      <circle cx="220" cy="140" r="30" fill="#fff" stroke={C.green} strokeWidth="3" />
      <path d="M220 154 C 210 145 204 139 204 132 C 204 126 209 123 213 125 C 216 126 219 129 220 131 C 221 129 224 126 227 125 C 231 123 236 126 236 132 C 236 139 230 145 220 154 Z" fill={C.heart} />
      {/* signal arcs */}
      <Wifi x={168} y={62} />
      <Wifi x={272} y={62} flip />
      {/* sparkles */}
      <Star x={38} y={78} s={1.1} />
      <Star x={410} y={210} s={1.3} />
      <Star x={220} y={250} s={0.8} color={C.green} />
    </svg>
  );
}

/** Single companion on the phone — for the "Become a Companion" section. */
export function CompanionCaller({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 320 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
      <Person id="solo" cx={160} cy={150} r={96} bg={C.mintCircle} hair="darkBun" top={C.peachTop} phoneRight />
      <Wifi x={244} y={70} flip />
      <Star x={40} y={96} s={1.2} />
      <Star x={286} y={224} s={1} color={C.green} />
      <Star x={70} y={250} s={0.8} />
    </svg>
  );
}
