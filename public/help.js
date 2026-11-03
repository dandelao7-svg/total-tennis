// The Help tab: a short how-to guide for whoever is signed in. Owners also get
// the pro and student guides (collapsed) so they can walk their people through it.
// Loaded after app.js — uses its VIEWS, S, PL helpers and the TT helpers.

(() => {
  const b = (t) => html`<strong>${t}</strong>`;
  const steps = (...items) => html`<ol>${items.map((i) => html`<li>${i}</li>`)}</ol>`;
  const sec = (title, ...body) => html`<section class="help-sec"><h3>${title}</h3>${body}</section>`;
  const contact = () => S.academy.contactPhone || S.academy.contactEmail || 'the academy';

  function studentGuide() {
    const a = S.academy;
    return [
      sec('Logging in',
        steps(html`Open your academy's booking page (the link the academy sent you) and log in with your email and password.`,
          html`New here? Click ${b('New student? Create an account')}.`,
          html`Forgot your password? Click ${b('Forgot your password?')} and we'll email you a link. It works for 60 minutes.`)),
      sec('Your skill rating comes first',
        html`<p>Group lessons are grouped by level. Until a pro rates you, you can't book group lessons yet. ${S.hidePrivate ? 'Ask' : `You can book a ${pl()} in the meantime, or ask`} the academy (${contact()}) to rate you.</p>`),
      sec('Buying lessons',
        steps(html`Click the ${b('Buy lessons')} tab and choose the month.`,
          html`Pick a pack and click ${b('Buy … only')}. You pay by card on a secure Stripe page.`,
          html`Your lesson credits appear straight away. ${creditWindow()}`),
        a.cardSurchargeBps > 0 ? html`<p class="hint">A ${a.cardSurchargeBps / 100}% card processing fee is added when you pay by card. To avoid it, pay the academy by cash, check or Zelle and they'll add your lessons.</p>` : '',
        a.renewAvailable ? html`<p><strong>Never run out:</strong> click ${b('Buy and renew every month')} to buy the same pack automatically on the 1st of each month. To stop it: ${b('Account')} → ${b('Turn off monthly renewal')}.</p>` : ''),
      sec('Booking a group lesson',
        steps(html`Click the ${b('Book a lesson')} tab. You only see lessons at your level.`,
          html`Click ${b('Book')} next to the lesson you want. It uses one credit of that length.`)),
      sec('Cancelling',
        steps(html`Click the ${b('My lessons')} tab.`,
          html`Click ${b('Cancel')} next to the lesson, then ${b('Cancel lesson')}.`),
        html`<p>You can cancel any time before the lesson starts and your credit comes back.</p>`),
      S.hidePrivate ? '' : sec(`Booking a ${pl()}`,
        steps(html`Click the ${b(PLs())} tab and click ${b('Book')} on an open time.`,
          html`Click ${b('Book it')}. You pay the pro directly by Zelle; their Zelle details are shown in ${b('My lessons')}.`)),
      sec('If the academy cancels (rain, etc.)',
        html`<p>You'll get an email${a.smsEnabled ? ' (and a text, if you ticked "Text me")' : ''}, and your group lesson credit goes back into your account automatically.</p>`),
      sec('Parents',
        html`<p>Use your child's account to buy and book for them. Each child needs their own account with its own email address. Notes your child's coaches share appear under ${b('My lessons')} → ${b('Notes from your coaches')}.</p>`),
      sec('Your details and password',
        html`<p>Use the ${b('Account')} tab to change your name, phone, email or password.</p>`),
    ];
  }

  function proGuide() {
    return [
      sec('First login',
        steps(html`Log in on the academy's booking page with the temporary password the owner gave you.`,
          html`Go to ${b('Account')} → ${b('Change password')} and choose your own.`,
          html`Also in ${b('Account')}: enter your ${b('Zelle')} so students know how to pay you for ${pls()}.`)),
      sec('Posting group lessons',
        steps(html`Click ${b('My schedule')} → ${b('+ Group lesson')}.`,
          html`Choose the ${b('Level')}, ${b('Length')}, start time and ${b('Court')}.`,
          html`To post the same lesson every week, choose how many weeks under ${b('Repeat weekly for')}.`,
          html`Click ${b('Post lesson')}. Students at that level can now book it.`)),
      sec('Taking attendance',
        steps(html`In ${b('My schedule')}, click ${b('Roster')} on the lesson.`,
          html`Tick ${b('Here?')} for each student who came. It saves by itself.`),
        html`<p>From the same roster you can ${b('+ Add a student')} or ${b('Remove')} one (their credit goes back).</p>`),
      sec('Cancelling a lesson',
        steps(html`Open the lesson's ${b('Roster')} → ${b('Cancel lesson')}.`,
          html`Type a reason (students see it) and click ${b('Cancel lesson')}. Booked students are emailed and get their credit back.`,
          html`To text them too, click ${b('Open in Messages')} for a group text, or ${b('Copy numbers')}.`)),
      sec('Rating new students',
        html`<p>New students can't book group lessons until they have a level.</p>`,
        steps(html`Click the ${b('Students')} tab. Unrated students are listed at the top.`,
          html`Click ${b('Rate')}, choose the ${b('Skill level')}, and click ${b('Save')}.`)),
      sec('Coaching notes',
        steps(html`In ${b('Students')}, click a student's name.`,
          html`Type a note, choose ${b('Student & parents can see')} or ${b('Staff only')}, and click ${b('Add note')}.`)),
      sec(PLs(),
        steps(html`Click ${b(PLs())} → ${b(`+ ${PL()} / open time`)}.`,
          html`Pick the time, length and court. Choose a ${b('Student')}, or leave it blank to post an open time students can book themselves.`,
          html`Click ${b('Save')}. When the student pays you, tick ${b('Student paid')}.`)),
      sec('Your hours and pay',
        html`<p>The ${b('My hours')} tab shows your group hours taught, your pay for the month, and any court fees you owe. If the academy rents court time for you, your court agreement and monthly court bill are there too. Use the ${b('Ask')} buttons to request changes; the owner approves them.</p>`),
    ];
  }

  function ownerGuide() {
    return [
      sec('First-time setup (Setup tab)',
        steps(html`${b('Your logo')}: upload it so students recognise you.`,
          html`${b('Locations & courts')}: click ${b('+ Location')}, enter the name, address and number of courts.`,
          html`${b('Tennis pros & staff')}: click ${b('+ Pro')} for each pro. A ${b('Temporary password')} is shown once. Give it to the pro along with your booking page link.`,
          html`${b('Lesson packs & prices')}: click ${b('+ Pack')} for each pack you sell.`,
          html`${b('Academy settings')}: check your contact details, court fee, group size and how long credits last, then click ${b('Save settings')}.`,
          html`${b('Card payments (Stripe)')}: follow ${b('How to connect')} so students can pay by card. TennisDesk support can help with this.`)),
      sec('Sharing your booking page',
        html`<p>On the ${b('Dashboard')}, click ${b('Copy link')} and send it to your students by email, text or your website. They sign up there themselves.</p>`),
      sec('Rain or a closed court: cancel a whole day',
        steps(html`Click ${b('Schedule')} → ${b('Cancel a day (weather)')}.`,
          html`Choose the ${b('Date')}, ${b('Where')}, a ${b('Reason')} and what happens to ${b('Lesson credits')}. The box shows how many lessons and students it affects.`,
          html`Click ${b('Cancel these lessons')}. Everyone booked is emailed.`,
          html`To text them as well, click ${b('Open in Messages')} for a group text, or ${b('Copy numbers')} and ${b('Copy message')}.`)),
      sec('Students',
        html`<p>In the ${b('Students')} tab, click a name to:</p>`,
        html`<ul>
          <li>${b('Rate level')} and add notes</li>
          <li>${b('Give free credits')} (make-ups, comps)</li>
          <li>${b('Reset password')} if they're locked out</li>
          <li>${b('Edit')} their details. Untick ${b('Active')} to stop someone logging in.</li>
        </ul>`),
      sec('Cash, check and Zelle payments',
        steps(html`Click ${b('Payments')} → ${b('+ Record cash / check / Zelle')}.`,
          html`Choose the student, pack and how they paid, then click ${b('Record payment')}. Their credits are added straight away.`),
        html`<p>${b('Payments')} also lists who hasn't bought lessons for this month yet, with their phone numbers.</p>`),
      sec('Refunds',
        html`<p>Refund card payments in your Stripe dashboard. Then open the student in ${b('Students')} and click ${b('Remove')} on the matching credits.</p>`),
      sec('Paying your pros (Payroll tab)',
        steps(html`Pick the month. Each pro's group hours, pay and court fees owed are worked out for you.`,
          html`Pay them the way you usually do, then click ${b('Mark paid')} to keep track.`)),
      sec('Court agreements',
        html`<p>Use these if you rent court time from the park for a pro and they owe the court fee whether they use it or not.</p>`,
        steps(html`${b('Setup')} → find the pro → ${b('Court times')} → ${b('+ Add court time')}.`,
          html`Each month's court bill is listed there. Use ${b('Waive (weather)')} for rained-out dates.`,
          html`When the pro pays, click ${b('Mark … received')}.`),
        html`<p>When a pro asks for a change, you'll see it on the ${b('Dashboard')}. Answer it in ${b('Payroll')} with ${b('Approve')} or ${b('Decline')}.</p>`),
      sec('Your TennisDesk subscription',
        html`<p>Go to ${b('Account')} → ${b('Billing')} to see your plan. Click ${b('Manage payment method & invoices')} to update your card.</p>`),
      sec('Need help?',
        html`<p>Email <a href="mailto:support@tennisdesk.app">support@tennisdesk.app</a>.</p>`),
    ];
  }

  VIEWS.help = async () => {
    const role = S.me.role;
    const who = role === 'admin' ? 'owners' : role === 'pro' ? 'pros' : 'students and parents';
    const main = role === 'admin' ? ownerGuide() : role === 'pro' ? proGuide() : studentGuide();
    $view.innerHTML = html`<div class="card help">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h1 style="margin:0">How to use ${S.academy.name}</h1>
        <button class="sm no-print" type="button" data-act="printHelp">Print</button>
      </div>
      <p class="muted">A quick guide for ${who}.${role === 'admin' ? '' : ` Questions? Contact ${contact()}.`}</p>
      ${main}
      ${role === 'admin' ? html`
        <details class="help-more"><summary>What your pros see</summary>${proGuide()}</details>
        <details class="help-more"><summary>What your students see</summary>${studentGuide()}</details>` : ''}
    </div>`.s;
  };

  // Printing expands the collapsed guides so the owner can hand them out.
  acts.printHelp = () => {
    document.querySelectorAll('.help-more').forEach((d) => { d.open = true; });
    window.print();
  };
})();
