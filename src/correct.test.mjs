import * as C from "./correct.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

const EVERYDAY = [[242,132,25],[214,40,40],[60,150,60],[242,220,40],[40,100,210],[140,90,40],
  [240,150,170],[140,60,180],[235,180,150],[70,140,55],[255,140,0],[200,60,30],[30,160,90],[250,200,60]];
const hue = lab => (Math.atan2(lab[2],lab[1])*180/Math.PI+360)%360;
const dHue = (a,b) => { const d = Math.abs(hue(a)-hue(b)); return d>180?360-d:d; };

function confusionPairs(profile, n=250) {
  const cols=[];
  for (let r=0;r<7;r++) for (let g=0;g<7;g++) for (let b=0;b<7;b++) {
    const lin=[r/6,g/6,b/6]; cols.push({lin, lab:C.toLab(lin), sim:C.toLab(C.simulate(lin,profile))});
  }
  const out=[];
  for (let i=0;i<cols.length;i++) for (let j=i+1;j<cols.length;j++)
    if (C.deltaE(cols[i].lab,cols[j].lab)>25 && C.deltaE(cols[i].sim,cols[j].sim)<8) out.push([cols[i].lin,cols[j].lin]);
  const st=Math.max(1,Math.floor(out.length/n)); return out.filter((_,i)=>i%st===0).slice(0,n);
}
function gains(profile, mode, t=0) {
  const g=[], abs=[];
  const pairs = confusionPairs(profile).length >= 20 ? confusionPairs(profile) : confusionPairs({axis:profile.axis, severity:1});
  for (const [a,b] of pairs) {
    const before=C.deltaE(C.toLab(C.simulate(a,profile)),C.toLab(C.simulate(b,profile)));
    const after =C.deltaE(C.toLab(C.simulate(C.correctPixel(a,profile,mode,t),profile)),C.toLab(C.simulate(C.correctPixel(b,profile,mode,t),profile)));
    g.push(after/Math.max(before,0.5)); abs.push(after-before);
  }
  g.sort((x,y)=>x-y); abs.sort((x,y)=>x-y);
  return { p10:g[Math.floor(g.length*0.1)], med:g[Math.floor(g.length/2)], absMed:abs[Math.floor(abs.length/2)], n:pairs.length };
}

const PROFILES = [
  {name:"deuteranomaly", axis:"deutan", severity:0.7},
  {name:"deuteranopia",  axis:"deutan", severity:1},
  {name:"protanomaly",   axis:"protan", severity:0.7},
  {name:"protanopia",    axis:"protan", severity:1},
  {name:"tritanopia",    axis:"tritan", severity:1},
];

for (const prof of PROFILES) {
  console.log(`\n${prof.name}`);
  // 1. hue guard on everyday colours (natural + pulse)
  for (const mode of ["natural","pulse","achromatic"]) {
    let sum=0,worst=0;
    for (const rgb of EVERYDAY) {
      const lin=C.from255(rgb);
      const h=dHue(C.toLab(lin),C.toLab(C.correctPixel(lin,prof,mode,0.37)));
      sum+=h; worst=Math.max(worst,h);
    }
    const mean=sum/EVERYDAY.length;
    const [cm,cw] = mode==="pulse" ? [20,31] : [10,22];
    ok(mean<=cm && worst<=cw, `${prof.name} ${mode} hue mean ${mean.toFixed(1)} worst ${worst.toFixed(1)}`);
    console.log(`  ${mode.padEnd(10)} hue mean ${mean.toFixed(1)}deg worst ${worst.toFixed(1)}deg`);
  }
  // 2. separation gains beat the untouched baseline
  for (const mode of ["natural","achromatic","split"]) {
    const g=gains(prof,mode);
    if (prof.severity>=1) ok(g.med>(prof.axis==='tritan'&&mode==='achromatic'?1.0:1.5), `${prof.name} ${mode} median gain ${g.med.toFixed(2)}`);
    else ok(g.absMed>=(mode==='natural'?3:-0.5), `${prof.name} ${mode} median dE gained ${g.absMed.toFixed(1)}`);
    console.log(`  ${mode.padEnd(10)} gain p10 x${g.p10.toFixed(2)} median x${g.med.toFixed(2)}  +${g.absMed.toFixed(1)} dE  (${g.n} pairs)`);
  }
  // 3. orange must stay orange (Z's bug)
  const o=C.from255([242,132,25]);
  const oh=hue(C.toLab(C.correctPixel(o,prof,"natural")));
  ok(oh>20 && oh<80, `${prof.name} orange hue ${oh.toFixed(0)}`);
  // 4. pulse: luminance constant across the whole cycle, and bounded rate
  let lumVar=0;
  for (const rgb of EVERYDAY) {
    const lin=C.from255(rgb); const ys=[];
    for (let t=0;t<1;t+=0.05) ys.push(C.luma(C.correctPixel(lin,prof,"pulse",t)));
    lumVar=Math.max(lumVar, Math.max(...ys)-Math.min(...ys));
  }
  ok(lumVar<0.02, `${prof.name} pulse luminance swing ${lumVar.toFixed(4)}`);
  ok(C.DEFAULTS.pulseHz<=1.5, "pulse rate within safe band");
  // 5. neutral invariance
  for (const g of [0.05,0.3,0.7,1]) for (const mode of C.MODES) {
    const out=C.correctPixel([g,g,g],prof,mode,0.2);
    ok(Math.max(...out.map(v=>Math.abs(v-g)))<1e-4, `${prof.name} ${mode} grey ${g} moved`);
  }
  // 6. output in gamut
  for (const rgb of EVERYDAY) for (const mode of C.MODES) {
    const out=C.correctPixel(C.from255(rgb),prof,mode,0.6);
    ok(out.every(v=>v>=-1e-9&&v<=1+1e-9), `${prof.name} ${mode} out of gamut`);
  }
}
// 7. severity 0 is identity
ok(C.deltaE(C.toLab([0.3,0.5,0.2]),C.toLab(C.correctPixel([0.3,0.5,0.2],{axis:"deutan",severity:0},"split")))<1e-9,"severity 0 identity");
// 8. compensation reduces correction magnitude
const p1={axis:"deutan",severity:0.7,compensation:0}, p2={axis:"deutan",severity:0.7,compensation:0.5};
const x=C.from255([180,90,60]);
ok(C.deltaE(C.toLab(x),C.toLab(C.correctPixel(x,p2,"natural"))) < C.deltaE(C.toLab(x),C.toLab(C.correctPixel(x,p1,"natural"))),"compensation lowers correction");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
