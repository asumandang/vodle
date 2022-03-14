import { Injectable } from '@angular/core';

import { environment } from '../environments/environment';
import { GlobalService } from './global.service';

/* TODO:
- add state, allow only certain state transitions, allow attribute change only in draft state
*/

// TYPES:

type poll_state_t = ""|"draft"|"running"|"closed";
type poll_type_t = "winner"|"share";
type poll_due_type_t = "custom"|"10min"|"hour"|"midnight"|"24hr"|"tomorrow-noon"|"tomorrow-night"
                        |"friday-noon"|"sunday-night"|"week"|"two-weeks"|"four-weeks";
type tally_cache_t = { // T is short for "tally data"
  // array of known vids:
  all_vids_set: Set<string>;
  // number of voters known:
  n_not_abstaining: number;
  // for each oid, an array of ascending ratings: 
  ratings_ascending_map: Map<string, Array<number>>;
  // for each oid, the approval cutoff (rating at and above which option is approved):
  cutoffs_map: Map<string, number>;
  // for each oid and vid, the approval (default: false):
  approvals_map: Map<string, Map<string, boolean>>;
  // for each oid, the approval score:
  approval_scores_map: Map<string, number>;
  // for each oid, the total rating:
  total_ratings_map: Map<string, number>;
  // for each oid, the effective score:
  scores_map: Map<string, number>;
  // oids sorted by descending score:
  oids_descending: Array<string>; 
  // for each vid, the voted-for option (or "" for abstention):
  votes_map: Map<string, string>;
  // for each oid (and "" for abstaining), the number of votes:
  n_votes_map: Map<string, number>;
  // for each oid, the winning probability/share:
  shares_map: Map<string, number>;
};
                      
// in the following, month index start at zero (!) while date index starts at one (!):
const LAST_DAY_OF_MONTH = {0:31, 1:28, 2:31, 3:30, 4:31, 5:30, 6:31, 7:31, 8:30, 9:31, 10:30, 11:31};
const VERIFY_TALLY = true;

// SERVICE:

@Injectable({
  providedIn: 'root'
})
export class PollService {

  private G: GlobalService;

  polls: Record<string, Poll> = {};

  ref_date: Date;

  get running_polls() {
    const res: Record<string, Poll> = {};
    for (const pid in this.polls) {
      const p = this.polls[pid];
      if (p.state=='running') {
        res[p.pid] = p;
      }
    }
    return res;
  }

  get closed_polls() {
    const res: Record<string, Poll> = {};
    for (const pid in this.polls) {
      const p = this.polls[pid];
      if (p.state=='closed') {
        res[p.pid] = p;
      }
    }
    return res;
  }

  get draft_polls() {
    const res: Record<string, Poll> = {};
    for (const pid in this.polls) {
      const p = this.polls[pid];
      if (p.state=='draft') {
        res[p.pid] = p;
      }
    }
    return res;
  }

  // TODO: store these two in D!
  private unused_pids: string[] = [];
  private unused_oids: string[][] = [];

  constructor() { }
  
  init(G:GlobalService) { 
    // called by GlobalService
    G.L.entry("PollService.init");
    this.G = G; 
  }

  generate_pid(): string {
    return this.unused_pids.pop() || this.G.D.generate_id(environment.data_service.pid_length); 
  }

  generate_oid(pid:string): string {
    if (!(pid in this.unused_oids)) this.unused_oids[pid] = [];
    return this.unused_oids[pid].pop() || this.G.D.generate_id(environment.data_service.oid_length);
  }

  generate_password(): string {
    return this.G.D.generate_id(environment.data_service.pwd_length);
  }

  generate_vid(): string {
    return this.G.D.generate_id(environment.data_service.vid_length);
  }

  update_ref_date() {
    this.ref_date = new Date();
  }

  update_own_rating(pid: string, vid: string, oid: string, value: number) {
    this.G.L.trace("PollService.update_own_rating", pid, vid, oid, value);
    let poll_ratings_map = this.G.D.own_ratings_map_caches[pid];
    if (!poll_ratings_map) {
      this.G.D.own_ratings_map_caches[pid] = poll_ratings_map = new Map();
    }
    let this_ratings_map = poll_ratings_map.get(oid);
    if (!this_ratings_map) {
      this_ratings_map = new Map();
      poll_ratings_map.set(oid, this_ratings_map); 
    }
    if (value != this_ratings_map.get(vid)) {
      if (pid in this.polls) {
        // let the poll object do the update:
        this.polls[pid].update_own_rating(vid, oid, value);
      } else {
        // just store the new value:
        this_ratings_map.set(vid, value);
      }
    }
  }

}


// ENTITY CLASSES:

export class Poll {

  private G: GlobalService;
  _state: string;  // cache for state since it is asked very often

  constructor (G:GlobalService, pid?:string) { 
    this.G = G;
    if (!pid) {
      // generate a new draft poll
      pid = this.G.P.generate_pid();
      this.state = 'draft';
//      this.G.D.setp(pid, 'pid', pid);
    } else {
      // copy state from db into cache:
      this._state = this.G.D.getp(pid, 'state') as poll_state_t;
    }
    G.L.entry("Poll.constructor", pid, this._state);
    this._pid = pid;
    this.G.P.polls[pid] = this;
    if (this._pid in this.G.D.tally_caches) { 
      this.T = this.G.D.tally_caches[this._pid] as tally_cache_t;
    } else if (!(this._state in [null, '', 'draft'])) {
      this.tally_all();
    }
    G.L.exit("Poll.constructor", pid);
  }

  delete() {
    this.G.L.entry("Poll.delete", this._pid);
    delete this.G.P.polls[this._pid];
    this.G.D.delp(this._pid, 'type');
    this.G.D.delp(this._pid, 'title');
    this.G.D.delp(this._pid, 'desc');
    this.G.D.delp(this._pid, 'url');
    this.G.D.delp(this._pid, 'language');
    this.G.D.delp(this._pid, 'db');
    this.G.D.delp(this._pid, 'db_from_pid');
    this.G.D.delp(this._pid, 'db_other_server_url');
    this.G.D.delp(this._pid, 'db_other_password');
    this.G.D.delp(this._pid, 'db_server_url');
    this.G.D.delp(this._pid, 'db_password');
    for (const oid of Object.keys(this._options)) {
      this._options[oid].delete();
    }
    this.G.D.delp(this._pid, 'password');
    this.G.D.delp(this._pid, 'vid');
    this.G.D.delp(this._pid, 'state');
    this.G.L.exit("Poll.delete", this._pid);
  }

  private _pid: string;
  get pid(): string { return this._pid; }
  // pid is read-only, set at construction

  // private attributes of the user:

  get creator(): string { return this.G.D.getp(this._pid, 'creator'); }
  set creator(value: string) {
    this.G.D.setp(this._pid, 'creator', value);
  }

  get have_acted(): boolean { return this.G.D.getp(this._pid, 'have_acted') == 'true'; }
  set have_acted(value: boolean) {
    this.G.D.setp(this._pid, 'have_acted', value.toString());
  }

  // attributes that are needed to access the poll's database 
  // and thus stored in user's personal data.
  // they may only be changed in state 'draft':

  get db(): string { return this.G.D.getp(this._pid, 'db'); }
  set db(value: string) { 
    if (this.state=='draft') this.G.D.setp(this._pid, 'db', value); 
  }

  get db_from_pid(): string { return this.G.D.getp(this._pid, 'db_from_pid'); }
  set db_from_pid(value: string) { 
    if (this.state=='draft') this.G.D.setp(this._pid, 'db_from_pid', value); 
  }

  get db_other_server_url(): string { return this.G.D.getp(this._pid, 'db_other_server_url'); }
  set db_other_server_url(value: string) { 
    if (this.state=='draft') this.G.D.setp(this._pid, 'db_other_server_url', value); 
  }

  get db_other_password(): string { return this.G.D.getp(this._pid, 'db_other_password'); }
  set db_other_password(value: string) { 
    if (this.state=='draft') this.G.D.setp(this._pid, 'db_other_password', value); 
  }

  // the following will be set only once at publish or join time:

  get db_server_url(): string { return this.G.D.getp(this._pid, 'db_server_url')}
  set db_server_url(value: string) {
    this.G.D.setp(this._pid, 'db_server_url', value); 
  }

  get db_password(): string { return this.G.D.getp(this._pid, 'db_password')}
  set db_password(value: string) { 
    this.G.D.setp(this._pid, 'db_password', value); 
  }

  get password(): string { return this.G.D.getp(this._pid, 'password'); }
  set password(value: string) {
    this.G.D.setp(this._pid, 'password', value);
  }

  get myvid(): string { return this.G.D.getp(this._pid, 'myvid'); }
  set myvid(value: string) {
    this.G.D.setp(this._pid, 'myvid', value);
  }

  // state is stored both in user's and in poll's (if not draft) database:

  get state(): poll_state_t { 
    // this is implemented as fast as possible because it is used so often
    return this._state as poll_state_t;
  }
  set state(new_state: poll_state_t) {
    const old_state = this.state;
    if (old_state==new_state) return;
    if ({
          null: ['draft'],
          '': ['draft'], 
          'draft': ['running'], 
          'running': ['closed']
        }[old_state].includes(new_state)) {
        this.G.D.change_poll_state(this, new_state);
        this._state = new_state;
    } else {
      this.G.L.error("Poll invalid state transition from "+old_state+" to "+new_state);
    }
  }

  // all other attributes are accessed via setp, getp, 
  // which automatically use the user's database for state 'draft' 
  // and the poll's database otherwise (in which case they are also read-only).

  get type(): poll_type_t { return this.G.D.getp(this._pid, 'type') as poll_type_t; }
  set type(value: poll_type_t) { this.G.D.setp(this._pid, 'type', value); }

  get language(): string { return this.G.D.getp(this._pid, 'language') as poll_type_t; }
  set language(value: string) { this.G.D.setp(this._pid, 'language', value); }

  get title(): string { return this.G.D.getp(this._pid, 'title'); }
  set title(value: string) { this.G.D.setp(this._pid, 'title', value); }

  get desc(): string { return this.G.D.getp(this._pid, 'desc'); }
  set desc(value: string) { this.G.D.setp(this._pid, 'desc', value); }

  get url(): string { return this.G.D.getp(this._pid, 'url'); }
  set url(value: string) { this.G.D.setp(this._pid, 'url', value); }

  get due_type(): poll_due_type_t { return this.G.D.getp(this._pid, 'due_type') as poll_due_type_t; }
  set due_type(value: poll_due_type_t) { this.G.D.setp(this._pid, 'due_type', value); }

  // Date objects are stored as ISO strings:

  get start_date(): Date {
    const str = this.G.D.getp(this._pid, 'start_date'); 
    return str==''?null:new Date(str); 
  }
  set start_date(value: Date) { 
    this.G.D.setp(this._pid, 'start_date', 
      ((value||'')!='') && (value.getTime() === value.getTime()) ? value.toISOString() : ''); 
  }

  get due_custom(): Date {
    const due_str = this.G.D.getp(this._pid, 'due_custom'); 
    return due_str==''?null:new Date(due_str); 
  }
  set due_custom(value: Date) { 
    this.G.D.setp(this._pid, 'due_custom', 
      // TODO: improve validity check already in form field!
      ((value||'')!='') && (value.getTime() === value.getTime()) ? value.toISOString() : ''); 
  }

  get due(): Date {
    const due_str = this.G.D.getp(this._pid, 'due'); 
    return due_str==''?null:new Date(due_str); 
  }
  set due(value: Date) { 
    this.G.D.setp(this._pid, 'due', 
      // TODO: improve validity check already in form field!
      ((value||'')!='') && (value.getTime() === value.getTime()) ? value.toISOString() : ''); 
  }
  get due_string(): string {
    return this.G.D.format_date(this.due);
  }

  private _options: Record<string, Option> = {};
  _add_option(o: Option) {
//    this.G.L.entry("Poll._add_option");
    // will only be called by the option itself to self-register in its poll!
    if (o.oid in this._options) {
      return false;
    } else {
      this._options[o.oid] = o;
      if (!this.own_ratings_map.has(o.oid)) this.own_ratings_map.set(o.oid, new Map());
      if (!this.proxy_ratings_map.has(o.oid)) this.proxy_ratings_map.set(o.oid, new Map());
      if (!this.direct_delegation_map.has(o.oid)) this.direct_delegation_map.set(o.oid, new Map());
      if (!this.inv_direct_delegation_map.has(o.oid)) this.inv_direct_delegation_map.set(o.oid, new Map());
      if (!this.indirect_delegation_map.has(o.oid)) this.indirect_delegation_map.set(o.oid, new Map());
      if (!this.inv_indirect_delegation_map.has(o.oid)) this.inv_indirect_delegation_map.set(o.oid, new Map());
      if (!this.effective_delegation_map.has(o.oid)) this.effective_delegation_map.set(o.oid, new Map());
      if (!this.inv_effective_delegation_map.has(o.oid)) this.inv_effective_delegation_map.set(o.oid, new Map());
      return true;
    }
  }

  get options(): Record<string, Option> { return this._options; }
  remove_option(oid: string) {
    if (oid in this._options) {
      delete this._options[oid];
      /* the following should not be necessary since options cannot be removed once running:
      this.own_ratings_map.delete(oid);
      this.effective_ratings_map.delete(oid);
      this.direct_delegation_map.delete(oid);
      this.inv_direct_delegation_map.delete(oid);
      this.indirect_delegation_map.delete(oid);
      this.inv_indirect_delegation_map.delete(oid);
      this.effective_delegation_map.delete(oid);
      this.inv_effective_delegation_map.delete(oid);
      */
      return true;
    } else {
      return false;
    }
  }
  get oids() { return Object.keys(this._options); }
  get n_options() { return this.oids.length; }

  get_my_own_rating(oid: string): number {
    if (!this.own_ratings_map.has(oid)) {
      this.own_ratings_map.set(oid, new Map());
    }
    const ratings_map = this.own_ratings_map.get(oid);
    if (!ratings_map.has(this.myvid)) {
      ratings_map.set(this.myvid, 0);
    }
    return ratings_map.get(this.myvid);
  }

  set_my_own_rating(oid: string, value: number, store: boolean=true) {
    /** Set own rating in caches and optionally store it in DB.
     * While a slider is dragged, this will be called with store=false,
     * when the slider is released, it will be called with store=true
     */
    if (value != 0) {
      this.have_acted = true;
    }
    if (store) {
      this.G.D.setv(this._pid, "rating." + oid, value.toString());
    }
    this.update_own_rating(this.myvid, oid, value);
  }

  get_my_proxy_rating(oid: string): number {
    return this.proxy_ratings_map.get(oid).get(this.myvid) || 0;
  }

  get remaining_time_fraction(): number {
    // the remaining running time as a fraction of the total running
    if ((this._state == "running")&&(!!this.start_date)&&(this.due)) {
      const t0 = this.start_date.getTime(),
          t1 = (new Date()).getTime(),
          t2 = this.due.getTime();
      return (t2 - t1) / (t2 - t0);
    } else {
      return null;
    }
  }

  get is_closing_soon(): boolean {
    if ((this._state == "running")&&(!!this.start_date)&&(this.due)) {
      return this.remaining_time_fraction < this.G.S.closing_soon_fraction;
    } else {
      return false;
    }
  }

  get am_abstaining(): boolean {
    /** whether or not I'm currently abstaining */
    if (!!this.T.votes_map) {
      const myvote = this.T.votes_map.get(this.myvid);
      return !myvote || myvote == "";
    } else {
      return false;
    }
  }

  get have_delegated(): boolean {
    const did = this.G.Del.get_my_outgoing_dids_cache(this.pid).get("*");
    if (!did) return false;
    const agreement = this.G.Del.get_agreement(this.pid, did);
    return (agreement.status == "agreed") && (agreement.active_oids.size == agreement.accepted_oids.size);
  }

  ratings_have_changed = false;

  // OTHER HOOKS:

  set_db_credentials() {
    // set db credentials according to this.db... settings:
    if (this.db=='central') {
      this.db_server_url = environment.data_service.central_db_server_url; 
      this.db_password = environment.data_service.central_db_password;
    } else if (this.db=='poll') {
      this.db_server_url = this.G.P.polls[this.db_from_pid].db_server_url;
      this.db_password = this.G.P.polls[this.db_from_pid].db_password;
    } else if (this.db=='other') {
      this.db_server_url = this.db_other_server_url;
      this.db_password = this.db_other_password;
    } else if (this.db=='default') {
      this.db_server_url = this.G.S.db_server_url;
      this.db_password = this.G.S.db_password;
    } 
    this.db_server_url = this.G.D.fix_url(this.db_server_url);
  }

  set_due() {
    // set due according to due_type, current date, and due_custom:
    if (this.due_type=='custom') {
      this.due = this.due_custom;
    } else {
      var due = new Date();
      const
//          year = due.getFullYear(), 
//          month = due.getMonth(), // 0=January!
//          dayofmonth = due.getDate(), 
          dayofweek = due.getDay(),
          due_as_ms = due.getTime();
      if (this.due_type=='midnight') {
        due.setHours(23, 59, 59, 999); // almost midnight on the same day according to local time
      } else if (this.due_type=='10min') {
        due = new Date(due_as_ms + 10*60*1000);
      } else if (this.due_type=='hour')  {
        due = new Date(due_as_ms + 60*60*1000);
      } else if (this.due_type=='24hr')  {
        due = new Date(due_as_ms + 24*60*60*1000);
      } else if (this.due_type=='tomorrow-noon') {
        due = new Date(due_as_ms + 24*60*60*1000);
        due.setHours(12, 0, 0, 0);
      } else if (this.due_type=='tomorrow-night') {
        due = new Date(due_as_ms + 24*60*60*1000);
        due.setHours(23, 59, 59, 999); 
      } else if (this.due_type=='friday-noon') {
        due = new Date(due_as_ms + ((5-dayofweek)%7)*24*60*60*1000);
        due.setHours(12, 0, 0, 0); 
      } else if (this.due_type=='sunday-night') {
        due = new Date(due_as_ms + ((7-dayofweek)%7)*24*60*60*1000);
        due.setHours(23, 59, 59, 999); 
      } else if (this.due_type=='week')  {
        due = new Date(due_as_ms + 7*24*60*60*1000);
        due.setHours(23, 59, 59, 999); 
      } else if (this.due_type=='two-weeks')  {
        due = new Date(due_as_ms + 2*7*24*60*60*1000);
        due.setHours(23, 59, 59, 999); 
      } else if (this.due_type=='four-weeks') {
        due = new Date(due_as_ms + 4*7*24*60*60*1000);
        due.setHours(23, 59, 59, 999); 
      }
      this.due = due;
    }
    this.G.L.info("PollService.set_due", due);
  }

  init_password() {
    // generate and store a random poll password:
    if ((this.password||'')=='') {
      this.password = this.G.P.generate_password(); 
      this.G.L.info("PollService.init_password", this.password);
    } else {
      this.G.L.error("Attempted to init_password() when password already existed.");
    }
  }

  init_myvid() {
    this.myvid = this.G.P.generate_vid();
    this.G.L.info("PollService.init_vid", this.myvid);
  }

  init_myratings() {
    for (const oid in this.options) {
      this.set_my_own_rating(oid, 0);
    }
  }

  after_incoming_changes() {
    if ((this.state == 'running') && (this.ratings_have_changed)) {
      this.tally_all();
      this.ratings_have_changed = false;
    }
  }

  // TALLYING:

  /* Implementation Notes: 
  - For performance reasons, we use Maps instead of Records here. 
  - CAUTION: map entries are NOT accessed via [...] and in but via .get(), .set() and .has() !
  - all Map type variables are named ..._map to make this unmistakable!
  */

  /** Ratings and Delegation
   * 
   * The tallying is based on all voters' *effective* ratings of all options.
   * 
   * A voter may or may not have delegated her rating of an option to some other voter.
   * 
   * If she has not done so,
   * her effective rating of an option equals her *own* rating that she set via the sliders in the poll page.
   * 
   * If a voter i has delegated her rating of an option x to another voter j,
   * her effective rating of x equals the own rating of x of her *effective delegate for x* .
   * 
   * If j has not delegated her rating of x to yet another voter k, 
   * then i's effective delegate for x is j.
   * Otherwise i's effective delegate for x equals j's effective delegate for x.
   * 
   * The relevant data for all this is stored in redundant form in the following maps,
   * which are also cached in DataService: 
   */

  // for each oid and vid, the base (pre-delegation) rating (default: 0):
  _own_ratings_map: Map<string, Map<string, number>>;
  get own_ratings_map(): Map<string, Map<string, number>> {
    if (!this._own_ratings_map) {
      if (this._pid in this.G.D.own_ratings_map_caches) {
        this._own_ratings_map = this.G.D.own_ratings_map_caches[this._pid];
      } else {
        this.G.D.own_ratings_map_caches[this._pid] = this._own_ratings_map = new Map();
        for (const oid of this.oids) {
          this._own_ratings_map.set(oid, new Map());
        }
        // TODO: copy my own ratings into it?
      }  
    }
    return this._own_ratings_map;
  }

  // for each oid and vid, the direct delegate's vid (default: null, meaning no delegation):
  _direct_delegation_map: Map<string, Map<string, string>>;
  get direct_delegation_map(): Map<string, Map<string, string>> {
    if (!this._direct_delegation_map) {
      if (this._pid in this.G.D.direct_delegation_map_caches) {
        this._direct_delegation_map = this.G.D.direct_delegation_map_caches[this._pid];
      } else {
        this.G.D.direct_delegation_map_caches[this._pid] = this._direct_delegation_map = new Map();
        for (const oid of this.oids) {
          this._direct_delegation_map.set(oid, new Map());
        }
      }  
    }
    return this._direct_delegation_map;
  }

  // for each oid and vid, the set of vids who directly delegated to this vid (default: null, meaning no delegation):
  _inv_direct_delegation_map: Map<string, Map<string, Set<string>>>;
  get inv_direct_delegation_map(): Map<string, Map<string, Set<string>>> {
    if (!this._inv_direct_delegation_map) {
      if (this._pid in this.G.D.inv_direct_delegation_map_caches) {
        this._inv_direct_delegation_map = this.G.D.inv_direct_delegation_map_caches[this._pid];
      } else {
        this.G.D.inv_direct_delegation_map_caches[this._pid] = this._inv_direct_delegation_map = new Map();
        for (const oid of this.oids) {
          this._inv_direct_delegation_map.set(oid, new Map());
        }
      }  
    }
    return this._inv_direct_delegation_map;
  }

  // for each oid and vid, the set of vids who this voter directly or indirectly delegated to (default: null, meaning no delegation):
  _indirect_delegation_map: Map<string, Map<string, Set<string>>>;
  get indirect_delegation_map(): Map<string, Map<string, Set<string>>> {
    if (!this._indirect_delegation_map) {
      if (this._pid in this.G.D.indirect_delegation_map_caches) {
        this._indirect_delegation_map = this.G.D.indirect_delegation_map_caches[this._pid];
      } else {
        this.G.D.indirect_delegation_map_caches[this._pid] = this._indirect_delegation_map = new Map();
        for (const oid of this.oids) {
          this._indirect_delegation_map.set(oid, new Map());
        }
      }  
    }
    return this._indirect_delegation_map;
  }

  // for each oid and vid, the set of vids who have directly or indirectly delegated to this voter (default: null, meaning no delegation):
  _inv_indirect_delegation_map: Map<string, Map<string, Set<string>>>;
  get inv_indirect_delegation_map(): Map<string, Map<string, Set<string>>> {
    if (!this._inv_indirect_delegation_map) {
      if (this._pid in this.G.D.inv_indirect_delegation_map_caches) {
        this._inv_indirect_delegation_map = this.G.D.inv_indirect_delegation_map_caches[this._pid];
      } else {
        this.G.D.inv_indirect_delegation_map_caches[this._pid] = this._inv_indirect_delegation_map = new Map();
        for (const oid of this.oids) {
          this._inv_indirect_delegation_map.set(oid, new Map());
        }
      }  
    }
    return this._inv_indirect_delegation_map;
  }

  // for each oid and vid, the effective delegate's vid (default: null, meaning no delegation):
  _effective_delegation_map: Map<string, Map<string, string>>;
  get effective_delegation_map(): Map<string, Map<string, string>> {
    if (!this._effective_delegation_map) {
      if (this._pid in this.G.D.effective_delegation_map_caches) {
        this._effective_delegation_map = this.G.D.effective_delegation_map_caches[this._pid];
      } else {
        this.G.D.effective_delegation_map_caches[this._pid] = this._effective_delegation_map = new Map();
        for (const oid of this.oids) {
          this._effective_delegation_map.set(oid, new Map());
        }
      }  
    }
    return this._effective_delegation_map;
  }

  // for each oid and vid, the set of vids who effectively delegated to this vid (default: null, meaning no delegation):
  _inv_effective_delegation_map: Map<string, Map<string, Set<string>>>;
  get inv_effective_delegation_map(): Map<string, Map<string, Set<string>>> {
    if (!this._inv_effective_delegation_map) {
      if (this._pid in this.G.D.inv_effective_delegation_map_caches) {
        this._inv_effective_delegation_map = this.G.D.inv_effective_delegation_map_caches[this._pid];
      } else {
        this.G.D.inv_effective_delegation_map_caches[this._pid] = this._inv_effective_delegation_map = new Map();
        for (const oid of this.oids) {
          this._inv_effective_delegation_map.set(oid, new Map());
        }
      }  
    }
    return this._inv_effective_delegation_map;
  }

  // for each oid and vid, the proxy (post-delegation) rating (default: 0):
  _proxy_ratings_map: Map<string, Map<string, number>>;
  get proxy_ratings_map(): Map<string, Map<string, number>> {
    if (!this._proxy_ratings_map) {
      if (this._pid in this.G.D.proxy_ratings_map_caches) {
        this._proxy_ratings_map = this.G.D.proxy_ratings_map_caches[this._pid];
      } else {
        this.G.D.proxy_ratings_map_caches[this._pid] = this._proxy_ratings_map = new Map();
        for (const oid of this.oids) {
          this._proxy_ratings_map.set(oid, new Map());
        }
        // TODO: copy my own ratings into it?
      }  
    }
    return this._proxy_ratings_map;
  }

  // for each oid and vid, the max (over oids) proxy rating (default: 0):
  _max_proxy_ratings_map: Map<string, number>;
  get max_proxy_ratings_map(): Map<string, number> {
    if (!this._max_proxy_ratings_map) {
      if (this._pid in this.G.D.max_proxy_ratings_map_caches) {
        this._max_proxy_ratings_map = this.G.D.max_proxy_ratings_map_caches[this._pid];
      } else {
        this.G.D.max_proxy_ratings_map_caches[this._pid] = this._max_proxy_ratings_map = new Map();
      }  
    }
    return this._max_proxy_ratings_map;
  }

  // for each oid and vid, the argmax (over oids) proxy rating (i.e., list of oids, default: []):
  _argmax_proxy_ratings_map: Map<string, Set<string>>;
  get argmax_proxy_ratings_map(): Map<string, Set<string>> {
    if (!this._argmax_proxy_ratings_map) {
      if (this._pid in this.G.D.argmax_proxy_ratings_map_caches) {
        this._argmax_proxy_ratings_map = this.G.D.argmax_proxy_ratings_map_caches[this._pid];
      } else {
        this.G.D.argmax_proxy_ratings_map_caches[this._pid] = this._argmax_proxy_ratings_map = new Map();
      }  
    }
    return this._argmax_proxy_ratings_map;
  }

  // for each oid and vid, the effective (post-delegation and post-adjustment to ensure some approval) rating (default: 0):
  _effective_ratings_map: Map<string, Map<string, number>>;
  get effective_ratings_map(): Map<string, Map<string, number>> {
    if (!this._effective_ratings_map) {
      if (this._pid in this.G.D.effective_ratings_map_caches) {
        this._effective_ratings_map = this.G.D.effective_ratings_map_caches[this._pid];
      } else {
        this.G.D.effective_ratings_map_caches[this._pid] = this._effective_ratings_map = new Map();
        for (const oid of this.oids) {
          this._effective_ratings_map.set(oid, new Map());
        }
      }  
    }
    return this._effective_ratings_map;
  }

  T: tally_cache_t;

  get agreement_level(): number  {
    const approval_scores_map = this.T.approval_scores_map, N = this.T.n_not_abstaining;
    let expected_approval_score = 0;
    for (const [oid, p] of this.T.shares_map.entries()) {
      expected_approval_score += p * approval_scores_map.get(oid);
    }
    return expected_approval_score / Math.max(1, N);
  }

  // Methods dealing with changes to the delegation graph:

  add_delegation(client_vid:string, oid:string, delegate_vid:string): boolean {
    /** Called whenever a delegation shall be added. Returns whether this succeeded */
    const dir_d_map = this.direct_delegation_map.get(oid), 
          eff_d_map = this.effective_delegation_map.get(oid), 
          new_eff_d_vid = eff_d_map.get(delegate_vid) || delegate_vid;
    // make sure no delegation exists yet and delegation would not create a cycle:
    if (dir_d_map.has(client_vid)) {

      if (dir_d_map.get(client_vid) == delegate_vid) {
        this.G.L.warn("PollService.add_delegation of existing delegation", client_vid, oid, delegate_vid, dir_d_map.get(client_vid));
        return true;
      } else {
        this.G.L.error("PollService.add_delegation when delegation already exists", client_vid, oid, delegate_vid, dir_d_map.get(client_vid));
        return false;  
      }

    } else if (new_eff_d_vid == client_vid) { 

      this.G.L.error("PollService.add_delegation when this would create a cycle", client_vid, oid, delegate_vid);
      return false;

    } else {

      this.G.L.trace("PollService.add_delegation feasible", client_vid, oid, delegate_vid);

      // register DIRECT delegation and inverse:
      dir_d_map.set(client_vid, delegate_vid);
      const inv_dir_d_map = this.inv_direct_delegation_map.get(oid);
      if (!inv_dir_d_map.has(delegate_vid)) {
        inv_dir_d_map.set(delegate_vid, new Set());
      }
      inv_dir_d_map.get(delegate_vid).add(client_vid);

      // update INDIRECT delegations and inverses:
      const ind_d_map = this.indirect_delegation_map.get(oid),
            ind_ds_of_delegate = ind_d_map.get(delegate_vid),
            inv_ind_d_map = this.inv_indirect_delegation_map.get(oid),
            inv_eff_d_map = this.inv_effective_delegation_map.get(oid);
      if (!inv_ind_d_map.has(delegate_vid)) {
        inv_ind_d_map.set(delegate_vid, new Set());
      }
      const inv_ind_ds_of_delegate = inv_ind_d_map.get(delegate_vid),
            inv_eff_ds_of_client = inv_eff_d_map.get(client_vid);
      // vid:
      const ind_ds_of_client = new Set([delegate_vid]);
      ind_d_map.set(client_vid, ind_ds_of_client);
      inv_ind_ds_of_delegate.add(client_vid);
      if (ind_ds_of_delegate) {
        for (const vid of ind_ds_of_delegate) {
          ind_ds_of_client.add(vid);
          if (!inv_ind_d_map.has(vid)) {
            inv_ind_d_map.set(vid, new Set());
          }
          inv_ind_d_map.get(vid).add(client_vid);
        }
      }
      // voters dependent on client:
      if (inv_eff_ds_of_client) {
        for (const vid of inv_eff_ds_of_client) {
          const ind_ds_of_vid = ind_d_map.get(vid);
          ind_ds_of_vid.add(delegate_vid);
          inv_ind_ds_of_delegate.add(vid);
          if (ind_ds_of_delegate) {
            for (const vid2 of ind_ds_of_delegate) {
              ind_ds_of_vid.add(vid2);
              if (!inv_ind_d_map.has(vid2)) {
                inv_ind_d_map.set(vid2, new Set());
              }
              inv_ind_d_map.get(vid2).add(vid);
            }
          }  
        }    
      }

      // update EFFECTIVE delegations, inverses, and proxy ratings: 
      const new_proxy_rating = this.own_ratings_map.get(oid).get(new_eff_d_vid) || 0;
      if (!inv_eff_d_map.has(new_eff_d_vid)) {
        inv_eff_d_map.set(new_eff_d_vid, new Set());
      }
      const inv_eff_ds_of_new_eff_d = inv_eff_d_map.get(new_eff_d_vid);
      // this vid:
      eff_d_map.set(client_vid, new_eff_d_vid);
      inv_eff_ds_of_new_eff_d.add(client_vid);
      this.update_proxy_rating(client_vid, oid, new_proxy_rating);
      // dependent voters:
      if (inv_eff_ds_of_client) {
        for (const vid of inv_eff_ds_of_client) {
          eff_d_map.set(vid, new_eff_d_vid);
          inv_eff_ds_of_new_eff_d.add(vid);
          this.update_proxy_rating(vid, oid, new_proxy_rating);
        }  
      }
      return true;
    }
  }

  del_delegation(client_vid: string, oid: string) {
    // Called whenever a voter revokes her delegation for some option
    const dir_d_map = this.direct_delegation_map.get(oid), 
          eff_d_map = this.effective_delegation_map.get(oid);
    // make sure a delegation exists:
    if (!dir_d_map.has(client_vid)) {
      this.G.L.error("PollService.del_delegation when no delegation exists", client_vid, oid);
    } else {
      const old_d_vid = dir_d_map.get(client_vid),
            old_eff_d_of_client = eff_d_map.get(client_vid),
            inv_dir_d_map = this.inv_direct_delegation_map.get(oid),
            ind_d_map = this.indirect_delegation_map.get(oid),
            old_ind_ds_of_client = ind_d_map.get(client_vid),
            inv_ind_d_map = this.inv_indirect_delegation_map.get(oid),
            inv_ind_ds_of_client = inv_ind_d_map.get(client_vid),
            inv_eff_d_map = this.inv_effective_delegation_map.get(oid),
            inv_eff_ds_of_client = inv_eff_d_map.get(client_vid),
            inv_eff_ds_of_old_eff_d_of_client = inv_eff_d_map.get(old_eff_d_of_client);

      // deregister DIRECT delegation and inverse of vid:
      dir_d_map.delete(client_vid);
      inv_dir_d_map.get(old_d_vid).delete(client_vid);

      // deregister INDIRECT delegation of vid to others:
      for (const vid of old_ind_ds_of_client) {
        inv_ind_d_map.get(vid).delete(client_vid);
      }
      ind_d_map.delete(client_vid);

      // deregister INDIRECT delegation of voters who indirectly delegated to vid to old indirect delegates of vid:
      if (inv_ind_ds_of_client) {
        for (const vid of inv_ind_ds_of_client) {
          const ind_ds_of_vid = ind_d_map.get(vid);
          for (const vid2 of old_ind_ds_of_client) {
            ind_ds_of_vid.delete(vid2);
            inv_ind_d_map.get(vid2).delete(vid);
          }
        }
      }

      // deregister EFFECTIVE delegation and inverse of vid and reset proxy rating to own rating:
      const new_proxy_rating = this.own_ratings_map.get(oid).get(client_vid) || 0;
      eff_d_map.delete(client_vid);
      inv_eff_ds_of_old_eff_d_of_client.delete(client_vid);
      this.update_proxy_rating(client_vid, oid, new_proxy_rating);

      // rewire EFFECTIVE delegation and inverse of voters who indirectly delegated to vid,
      // and update proxy ratings:
      if (inv_ind_ds_of_client) {
        for (const vid of inv_ind_ds_of_client) {
          inv_eff_ds_of_old_eff_d_of_client.delete(vid);
          eff_d_map.set(vid, client_vid);
          inv_eff_ds_of_client.add(vid);
          this.update_proxy_rating(vid, oid, new_proxy_rating);
        }            
      }
    }
  }

  get_n_indirect_option_clients(vid: string, oid: string): number {
    /** count how many voters have indirectly delegated to vid for oid */
    return (this.inv_indirect_delegation_map.get(oid).get(vid)||new Set()).size;
  }

  get_n_indirect_clients(vid: string): number {
    /** count how many voters have indirectly delegated to vid for some oid */
    let clients = new Set();
    for (const oid of this.oids) {
      for (const vid2 of (this.inv_indirect_delegation_map.get(oid).get(vid)||new Set())) {
        clients.add(vid2);
      }
    }
    return clients.size;
  }

  tally_all() {
    // Called after initialization and when changes come via the db.
    // Tallies all. 
    this.G.L.entry("Poll.tally_all", this._pid);

    this.G.D.tally_caches[this._pid] = this.T = {
      all_vids_set: new Set(),
      n_not_abstaining: 0,
      ratings_ascending_map: new Map(),
      cutoffs_map: new Map(),
      approvals_map: new Map(),
      approval_scores_map: new Map(),
      total_ratings_map: new Map(),
      scores_map: new Map(),
      oids_descending: [],
      votes_map: new Map(),
      n_votes_map: new Map(),
      shares_map: new Map()
    }
    // extract voters and total_ratings:
    for (const [oid, proxy_rs_map] of this.proxy_ratings_map) {
//      this.G.L.trace("Poll.tally_all rating", this._pid, oid, [...rs_map]);
      let t = 0;
      for (const [vid, r] of proxy_rs_map) {
//        this.G.L.trace("Poll.tally_all rating", this._pid, oid, vid, r);
        this.T.all_vids_set.add(vid);
        t += r;
      }
      this.T.total_ratings_map.set(oid, t);
    }

    // count non-abstaining voters:
    this.T.n_not_abstaining = 0;
    for (const vid of this.T.all_vids_set) {
      if (this.max_proxy_ratings_map.get(vid) || 0 > 0) {
        this.T.n_not_abstaining += 1;
      }
    }

//    this.G.L.trace("Poll.tally_all voters", this._pid, this.T.n_voters, [...this.T.allvids_set]);
    // calculate cutoffs, approvals, and scores of all options:
    const score_factor = this.T.n_not_abstaining * 128;
//    this.G.L.trace("Poll.tally_all options", this._pid, this._options);
    for (const oid of this.oids) {
      const eff_rs_map = this.effective_ratings_map.get(oid);
//      this.G.L.trace("Poll.tally_all rs_map", this._pid, oid, [...rs_map]);
      if (eff_rs_map) {
        const rsasc = this.update_ratings_ascending(oid, eff_rs_map);
//        this.G.L.trace("Poll.tally_all rsasc", this._pid, oid, [...rs_map], [...rsasc]);
        this.update_cutoff_and_approvals(oid, eff_rs_map, rsasc);
        const [apsc, _dummy] = this.update_approval_score(oid, this.T.approvals_map.get(oid));
        this.update_score(oid, apsc, this.T.total_ratings_map.get(oid), score_factor);
//        this.G.L.trace("Poll.tally_all aps, apsc, sc", this._pid, oid, this.T.approvals_map.get(oid), apsc, this.T.scores_map.get(oid));
      } else {
        this.T.ratings_ascending_map.set(oid, []);
        this.T.cutoffs_map.set(oid, 100);
        this.T.approvals_map.set(oid, new Map());
        this.T.approval_scores_map.set(oid, 0);
        this.T.total_ratings_map.set(oid, 0);
        this.T.scores_map.set(oid, 0); 
      }
    }
//    this.G.L.trace("Poll.tally_all scores", this._pid, [...this.T.scores_map]);
    // order and calculate votes and shares:
    this.update_ordering();
    const oidsdesc = this.T.oids_descending;
//    this.G.L.trace("Poll.tally_all oidsdesc", this._pid, oidsdesc);
    for (const vid of this.T.all_vids_set) {
      this.update_vote(vid, oidsdesc);
    }
//    this.G.L.trace("Poll.tally_all votes", this._pid, this.T.votes_map);
    if (this.update_shares(oidsdesc)) {
      this.G.L.trace("Poll.tally_all pie charts need updating");
      if (!!this.G.D.page && typeof this.G.D.page['show_stats'] === 'function') {
        this.G.D.page.show_stats();
      }
    }
//    this.G.L.trace("Poll.tally_all n_votes, shares", this._pid, [...this.T.n_votes_map], [...this.T.shares_map]);

    this.G.L.exit("Poll.tally_all", this._pid);
  }

  // Methods dealing with individual rating updates:

  update_own_rating(vid: string, oid: string, value: number) {
    // Called whenever a rating is updated.
    // Updates the affected effective ratings based on delegation data.
    // if changed, update rating:
    this.G.L.trace("Poll.update_own_rating", this.pid, vid, oid, value);
    if (!this.own_ratings_map.has(oid)) {
      this.own_ratings_map.set(oid, new Map());
      this.G.L.trace("Poll.update_own_rating first own rating for option", oid);
    }
    const rs_map = this.own_ratings_map.get(oid), old_value = rs_map.get(vid) || 0;
    this.G.L.trace("Poll.update_own_rating old rating:", this.pid, vid, oid, old_value);
    if (value != old_value) {
      // store new value:
      rs_map.set(vid, value);
      this.G.L.trace("Poll.update_own_rating new ratings map", this.pid, oid, [...rs_map.entries()]);
      // check whether vid has not delegated:
      if (!this.direct_delegation_map.get(oid)) {
        this.direct_delegation_map.set(oid, new Map());
      }
      if (!this.direct_delegation_map.get(oid).has(vid)) {
        this.G.L.trace("Poll.update_own_rating voter has not delegated", this.pid, vid, oid);
        // vid has not delegated this rating,
        // so update all dependent voters' effective ratings:
        this.update_proxy_rating(vid, oid, value);
        const vid2s = this.inv_effective_delegation_map.get(oid).get(vid);
        if (vid2s) {
          for (const vid2 of vid2s) {
            // vid2 effectively delegates their rating of oid to vid,
            // hence we store vid's new rating of oid as vid2's effective rating of oid:
            this.update_proxy_rating(vid2, oid, value);
          }
        }
      }
    }
  }

  update_proxy_rating(vid: string, oid: string, value: number) {
    // Called whenever a proxy rating is updated.
    // Updates a rating and all depending quantities up to the final shares.
    // Tries to do this as efficiently as possible.
    this.G.L.entry("Poll.update_proxy_rating", this.pid, vid, oid, value);

    // if necessary, register voter:
    let n_changed = false;
    if (!this.T.all_vids_set.has(vid)) {
      this.T.all_vids_set.add(vid);
      this.T.n_not_abstaining = this.T.all_vids_set.size;
      n_changed = true;
      this.G.L.trace("Poll.update_proxy_rating n_changed, first proxy rating of voter", vid);
    }
    // if changed, update proxy rating:
    if (!this.proxy_ratings_map.has(oid)) {
      this.proxy_ratings_map.set(oid, new Map());
      this.G.L.trace("Poll.update_proxy_rating first proxy rating for option", oid);
    }

    const proxy_rs_map = this.proxy_ratings_map.get(oid), old_value = proxy_rs_map.get(vid) || 0;
    if (value != old_value) {
      this.G.L.trace("Poll.update_proxy_rating proxy rating of", oid, "by", vid, "changed from", old_value, "to", value);
      if (value != 0) {
        proxy_rs_map.set(vid, value);
      } else {
        proxy_rs_map.delete(vid);
      }
      // update depending data:

      // update effective ratings of this oid and potentially other oids:
      const old_max_r = this.max_proxy_ratings_map.get(vid) || 0,
            old_argmax_r_set = this.argmax_proxy_ratings_map.get(vid) || new Set(),
            eff_rating_changes_map = new Map<string, number>();
      this.G.L.trace("Poll.update_proxy_rating old max, argmax",old_max_r,[...old_argmax_r_set]);
      var max_r = old_max_r, 
      argmax_r_set = old_argmax_r_set;
      if (old_max_r == 0) {
        this.G.L.trace("Poll.update_proxy_rating old max was 0");
        // voter was abstaining before but is no longer since value > 0 
        // => set new max and adjust rating to effectively 100 to ensure approval of oid:
        max_r = value;
        argmax_r_set = new Set([oid]);
        eff_rating_changes_map.set(oid, 100);
        n_changed = true;
      } else if (old_max_r == 100) {
        this.G.L.trace("Poll.update_proxy_rating old max was 100");
        // some options were actually rated 100
        if (old_value == 100) {
          // oid was a favourite, so check if the only one:
          if (argmax_r_set.size == 1) {
            this.G.L.trace("Poll.update_proxy_rating option decreased from only favourite");
            // oid was sole favourite, have to find new max!
            max_r = -1;
            argmax_r_set = new Set();
            for (const oid2 of this.oids) {
              const r2 = this.proxy_ratings_map.get(oid2).get(vid) || 0;
              if (r2 > max_r) {
                max_r = r2;
                argmax_r_set = new Set([oid2]);
              } else if (r2 == max_r) {
                argmax_r_set.add(oid2);
              }
            }
            // resulting eff ratings changes:
            if (max_r == 0) {
              // voter begins abstaining.
              eff_rating_changes_map.set(oid, 0);
              n_changed = true;
            } else {
              if (!argmax_r_set.has(oid)) {
                // oid no longer fav, so set proxy value as eff value:
                eff_rating_changes_map.set(oid, value);
              }
              for (const oid2 of argmax_r_set) {
                if (oid2 != oid) {
                  eff_rating_changes_map.set(oid2, 100);
                }
              }  
            }
          } else {
            // there were other favourites, so max stays at 100, so simply remove from argmax and set new value:
            this.G.L.trace("Poll.update_proxy_rating option decreased from several favourites");
            argmax_r_set.delete(oid);
            eff_rating_changes_map.set(oid, value);
          }
        } else {
          this.G.L.trace("Poll.update_proxy_rating option changed from non-favourite");
          // oid was no favourite, so check if it becomes one:
          if (value == 100) {
            // oid becomes additional favourite, so add to argmax:
            argmax_r_set.add(oid);
          }
          // set new value:
          eff_rating_changes_map.set(oid, value);
        }
      } else {
        this.G.L.trace("Poll.update_proxy_rating old max was >0 and <100");
        // no option was actually rated 100, so eff. ratings differ from proxy ratings
        if (old_value == max_r) {
          // oid was a favourite, so has eff. rating 100.
          if (value < old_value) {
            // rating decreases.
            // check if oid is the only fav.:
            if (argmax_r_set.size == 1) {
              this.G.L.trace("Poll.update_proxy_rating option decreased from only favourite");
              // oid was sole favourite, have to find new max!
              max_r = -1;
              argmax_r_set = new Set();
              for (const oid2 of this.oids) {
                const r2 = this.proxy_ratings_map.get(oid2).get(vid) || 0;
                if (r2 > max_r) {
                  max_r = r2;
                  argmax_r_set = new Set([oid2]);
                } else if (r2 == max_r) {
                  argmax_r_set.add(oid2);
                }
              }
              // resulting eff ratings changes:
              if (max_r == 0) {
                // voter begins abstaining.
                eff_rating_changes_map.set(oid, 0);
                n_changed = true;
              } else {
                if (!argmax_r_set.has(oid)) {
                  // oid no longer fav, so set proxy value as eff value:
                  eff_rating_changes_map.set(oid, value);
                }
                for (const oid2 of argmax_r_set) {
                  if (oid2 != oid) {
                    eff_rating_changes_map.set(oid2, 100);
                  }
                }  
              }
            } else {
              this.G.L.trace("Poll.update_proxy_rating option decreased from several favourites");
              // there were other favourites, so simply remove from argmax and set new value:
              argmax_r_set.delete(oid);
              eff_rating_changes_map.set(oid, value);
            }
          } else {
            // rating increases.
            // check if oid is the only fav.:
            if (argmax_r_set.size == 1) {
              this.G.L.trace("Poll.update_proxy_rating option increased from only favourite");
              // oid remains sole favourite
            } else {
              this.G.L.trace("Poll.update_proxy_rating option increased from several favourites");
              // oid becomes sole favourite, other favs. eff. ratings go down to their proxy ratings:
              for (const oid2 of argmax_r_set) {
                if (oid2 != oid) {
                  eff_rating_changes_map.set(oid2, this.proxy_ratings_map.get(oid2).get(vid));
                }
              }
              argmax_r_set = new Set([oid]);
            }
            max_r = value;
          }
        } else {
          // oid was no favourite, so check if it becomes one:
          if (value < old_value) {
            this.G.L.trace("Poll.update_proxy_rating option decreased from non-favourite");
            // rating decreases, so just register rating:
            eff_rating_changes_map.set(oid, value);
          } else {
            // oid might become a fav.::
            if (value == max_r) {
              this.G.L.trace("Poll.update_proxy_rating option increased to several favourites");
              // rating increases to current max, so oid becomes additional fav.
              argmax_r_set.add(oid);
              eff_rating_changes_map.set(oid, 100);
            } else if (value > max_r) {
              this.G.L.trace("Poll.update_proxy_rating option increased to only favourite");
              // rating increases beyond current max, so oid becomes sole fav. with eff, rating 100
              // other favs. eff. ratings go down to their proxy ratings:
              for (const oid2 of argmax_r_set) {
                if (oid2 != oid) {
                  eff_rating_changes_map.set(oid2, this.proxy_ratings_map.get(oid2).get(vid));
                }
              }
              max_r = value;
              argmax_r_set = new Set([oid]);
              eff_rating_changes_map.set(oid, 100);
            } else {
              this.G.L.trace("Poll.update_proxy_rating option increased to non-favourite");
              eff_rating_changes_map.set(oid, value);
            }
          }
        }
      }
      this.G.L.trace("PollService.update_proxy_rating",n_changed,eff_rating_changes_map,old_max_r,max_r,[...old_argmax_r_set],[...argmax_r_set]);
      // store new max, argmax:
      if (max_r > 0) {
        this.max_proxy_ratings_map.set(vid, max_r);
      } else {
        this.max_proxy_ratings_map.delete(vid);
      }
      this.argmax_proxy_ratings_map.set(vid, argmax_r_set);
      // now update what needs to be updated as a consequence:
      if (eff_rating_changes_map.size > 0) {
        this.update_proxy_rating_phase2(vid, n_changed, eff_rating_changes_map);
      }
    }
    if (VERIFY_TALLY) {
      const candidate = new Map(this.T.shares_map);
      this.tally_all();
      for (const oid of this.T.shares_map.keys()) {
        if (this.T.shares_map.get(oid) != candidate.get(oid)) {
          this.G.L.warn("Poll.update_rating produced inconsistent shares:", [...candidate], [...this.T.shares_map]);
          return;
        }
      }
//      this.G.L.trace("Poll.update_rating produced consistent shares:", [...candidate], [...this.T.shares_map]);
    }
  }

  private update_proxy_rating_phase2(vid: string, n_changed: boolean, eff_rating_changes_map: Map<string, number>) {
    // process the consequences of changing one or more effective ratings of vid
    this.G.L.entry("PollService.update_proxy_rating_phase2",vid,n_changed,[...eff_rating_changes_map.entries()]);
    for (const [oid, value] of eff_rating_changes_map) {
      // register change in map and get old eff. rating:
      var eff_rs_map = this.effective_ratings_map.get(oid);
      if (!eff_rs_map) {
        eff_rs_map = new Map();
        this.effective_ratings_map.set(oid, eff_rs_map);
      }
      const old_value = eff_rs_map.get(vid) || 0;
      if (value > 0) {
        eff_rs_map.set(vid, value);
      } else {
        eff_rs_map.delete(vid);
      }
      // update ratings_ascending faster than by resorting:
      const ratings_ascending_old = this.T.ratings_ascending_map.get(oid) || [...eff_rs_map.values()];
      const index = ratings_ascending_old.indexOf(old_value);
      // replace old value by new:
      ratings_ascending_old[index] = value;
      // repair ordering:
      let ratings_ascending = ratings_ascending_old.sort((n1,n2)=>n1-n2);      
/*      // remove old value:
      const rsasc_without = ratings_ascending_old.slice(0, index).concat(ratings_ascending_old.slice(index + 1));
      // insert new value at correct position:
      let ratings_ascending = rsasc_without;
      for (let index=0; index<rsasc_without.length; index++) {
        if (ratings_ascending_old[index] >= value) {
          ratings_ascending = rsasc_without.slice(0, index).concat([value]).concat(rsasc_without.slice(index));    
          break;
        }
      }
      if (ratings_ascending.length < this.T.n_not_abstaining) {
        ratings_ascending.push(value);
      }
*/
      // store result back:
      this.T.ratings_ascending_map.set(oid, ratings_ascending);

      // cutoff, approvals:
      const [cutoff, cutoff_changed, others_approvals_changed] = this.update_cutoff_and_approvals(oid, eff_rs_map, ratings_ascending);

      let vids_approvals_changed = false;
      const approvals_map = this.T.approvals_map.get(oid);
      if (!others_approvals_changed) {
        // update vid's approval since it has not been updated automatically by update_cutoff_and_approvals:
        const approval = (value >= cutoff);
        if (approval != approvals_map.get(vid)) {
          approvals_map.set(vid, approval);
          vids_approvals_changed = true;
        }
      }
      let svg_needs_update = false;
      if (vids_approvals_changed || others_approvals_changed) {
        // update approval score:
        this.G.L.trace("Poll.update_rating approvals changed", vids_approvals_changed, others_approvals_changed);
        var approval_score;
        [approval_score, svg_needs_update] = this.update_approval_score(oid, approvals_map);
      }
      // update total ratings and score(s):
      const total_rating = (this.T.total_ratings_map.get(oid) || 0) + value - old_value,
            score_factor = this.T.n_not_abstaining * 128;
      this.T.total_ratings_map.set(oid, total_rating);
      if (n_changed) {
        // update all scores:
        for (const oid2 of this.T.scores_map.keys()) {
          this.update_score(oid2, this.T.approval_scores_map.get(oid2), this.T.total_ratings_map.get(oid2), score_factor);
        }
      } else {
        // only update oid's score:
        this.update_score(oid, this.T.approval_scores_map.get(oid), total_rating, score_factor);
      }
      // update option ordering:
      const [oidsdesc, ordering_changed] = this.update_ordering();
      let votes_changed = false;
      if (ordering_changed || others_approvals_changed) {
        // update everyone's votes:
        this.G.L.trace("Poll.update_rating updating everyone's votes", ordering_changed);
        for (const vid2 of this.T.all_vids_set) {
          votes_changed ||= this.update_vote(vid2, oidsdesc);
        }
      } else if (vids_approvals_changed) {
        // update only vid's vote:
        this.G.L.trace("Poll.update_rating updating vid's vote");
        votes_changed = this.update_vote(vid, oidsdesc);
      } else {
        // neither the ordering nor the approvals have changed, 
        // so the votes and winning probabilities/shared don't change either
      }
      if (votes_changed || n_changed) {
        // update winning probabilities/shares:
        this.G.L.trace("Poll.update_rating updating shares", votes_changed);
        const shares_changed = this.update_shares(oidsdesc);
        if (shares_changed) {
          svg_needs_update = true;
        }
      }
      if (svg_needs_update) {
        this.G.L.trace("Poll.update_rating pie charts need updating");
        if (!!this.G.D.page && typeof this.G.D.page['show_stats'] === 'function') {
          this.G.D.page.show_stats();
        }
      }
    }
  }

  update_ratings_ascending(oid: string, eff_rs_map: Map<string, number>): Array<number> {
    // sort ratings ascending:
    const eff_rs_asc_non0 = Array.from(eff_rs_map.values()).sort((n1,n2)=>n1-n2) as Array<number>;
//    this.G.L.trace("PollService.update_ratings_ascending", [...eff_rs_map.entries()], eff_rs_asc_non0, this.T.n_not_abstaining);
    // make sure array is correct length by padding with zeros:
    const eff_rs_asc = Array(this.T.n_not_abstaining - eff_rs_asc_non0.length).fill(0).concat(eff_rs_asc_non0);
    this.T.ratings_ascending_map.set(oid, eff_rs_asc);
    return eff_rs_asc;
  }

  update_cutoff_and_approvals(oid: string, eff_rs_map: Map<string, number>, eff_rs_asc: Array<number>): [number, boolean, boolean] {
    // update approval cutoff:
    let cutoff = 100;
    const cutoff_factor = 100 / this.T.n_not_abstaining;
    for (let index=0; index<this.T.n_not_abstaining; index++) {
      const rating = eff_rs_asc[index];
      // check whether strictly less than r percent have a rating strictly less than r:
      const pct_less_than_r = cutoff_factor * index;
      if (pct_less_than_r < rating) {
        cutoff = rating;
        break;
      }
    }
    if (!(this.T.approvals_map.has(oid))) {
      this.T.approvals_map.set(oid, new Map());
    }
    // update approvals:
    let cutoff_changed = false,
        approvals_changed = false;
    const approvals_map = this.T.approvals_map.get(oid);
    if (cutoff != this.T.cutoffs_map.get(oid)) {
      // cutoff has changed, so update all approvals:
      this.T.cutoffs_map.set(oid, cutoff);
      cutoff_changed = true;
//      this.G.L.trace("Poll.update_cutoff_and_approvals changed to", cutoff);
      for (const vid of this.T.all_vids_set) {
        const rating = eff_rs_map.get(vid) || 0,
              approval = (rating >= cutoff);
        if (approval != approvals_map.get(vid)) {
          approvals_map.set(vid, approval);
          approvals_changed = true;  
        }
      }
    }
    return [cutoff, cutoff_changed, approvals_changed];
  }

  update_approval_score(oid: string, approval_map: Map<string, boolean>): [number, boolean] {
    const approval_score = Array.from(approval_map.values()).filter(x => x==true).length;
    if (approval_score != this.T.approval_scores_map.get(oid)) {
      this.T.approval_scores_map.set(oid, approval_score);
      return [approval_score, true];
    }
    return [approval_score, false];
  }

  update_score(oid: string, approval_score: number, total_rating: number, score_factor: number) {
    // TODO: make the following tie-breaker faster by storing i permanently.
    // calculate a tiebreaking value between 0 and 1 based on the hash of the option name:
    const tie_breaker = parseFloat('0.'+parseInt(this.G.D.hash(this.options[oid].name), 16).toString());
    this.T.scores_map.set(oid, approval_score * score_factor + total_rating + tie_breaker);
  }

  update_ordering(): [Array<string>, boolean] {
    const oidsdesc = [...this.T.scores_map]
          .sort(([oid1, sc1], [oid2, sc2]) => sc2 - sc1)
          .map(([oid2, sc2]) => oid2);
    // check whether ordering changed:
    let ordering_changed = false;
    for (let index=0; index<oidsdesc.length; index++) {
      if (oidsdesc[index] != this.T.oids_descending[index]) {
        ordering_changed = true;
        this.T.oids_descending = oidsdesc;
        break;
      }  
    }
    return [oidsdesc, ordering_changed];
  }

  update_vote(vid: string, oids_desc: Array<string>): boolean {
    let vote = "", vote_changed = false;
    for (const oid2 of oids_desc) {
      if (this.T.approvals_map.get(oid2).get(vid)) {
        vote = oid2;
        break;
      }
    }
    if (vote != this.T.votes_map.get(vid)) {
      this.T.votes_map.set(vid, vote);
      vote_changed = true;
    }
    return vote_changed;
  }

  update_shares(oids_desc: Array<string>): boolean {
    let total_n_votes = 0,
        shares_changed = false;
    this.T.n_votes_map.set("", 0); 
    for (const oid of oids_desc) {
      this.T.n_votes_map.set(oid, 0);
    }
    for (const vid of this.T.all_vids_set) {
      const vote = this.T.votes_map.get(vid) || '';
      this.T.n_votes_map.set(vote, (this.T.n_votes_map.get(vote) || 0) + 1);
      if (vote != "") {
        total_n_votes++;
      }
    }
    if (total_n_votes > 0) {
      // shares are proportional to votes received:
      for (const oid of oids_desc) {
        const share = (this.T.n_votes_map.get(oid) || 0) / total_n_votes;
        if (share != this.T.shares_map.get(oid)) {
          this.G.L.trace("PollPage.update_shares",this.pid, oid, share);
          this.T.shares_map.set(oid, share);
          shares_changed = true;
        }
      }  
    } else {
      // all abstained, so shares are uniform:
      const k = oids_desc.length;
      for (const oid of oids_desc) {
        const share = 1 / k;
        if (share != this.T.shares_map.get(oid)) {
          this.G.L.trace("PollPage.update_shares",this.pid, oid, share);
          this.T.shares_map.set(oid, share);
          shares_changed = true;
        }
      }  
    }
    return shares_changed;
  }

}



export class Option {

  private G: GlobalService;
  private p: Poll;

  constructor (G:GlobalService, poll:Poll, oid:string=null, 
               name:string=null, desc:string=null, url:string=null) { 
    // TODO: ensure uniqueness of name within poll!
    this.G = G;
//    this.G.L.entry("Option constructor");
    this.p = poll;
    if (!oid) {
      oid = this.G.P.generate_oid(poll.pid);
      this.G.D.setp(poll.pid, 'option.'+oid+'.oid', oid);
      this.G.L.trace("...new option", poll.pid, oid);
    }
    this._oid = oid;
    if ((name||'')!='') this.G.D.setp(poll.pid, 'option.'+oid+'.name', name);
    if ((desc||'')!='') this.G.D.setp(poll.pid, 'option.'+oid+'.desc', desc);
    if ((url||'')!='') this.G.D.setp(poll.pid, 'option.'+oid+'.url', url);
    poll._add_option(this);
//    this.G.L.exit("Option constructor");
  }

  delete() {
    this.p.remove_option(this.oid);
    this.G.D.delp(this.p.pid, 'option.'+this.oid+'.name');
    this.G.D.delp(this.p.pid, 'option.'+this.oid+'.desc');
    this.G.D.delp(this.p.pid, 'option.'+this.oid+'.url');
  }

  private _oid: string;
  get oid(): string { return this._oid; }
  // oid is read-only, set at construction

  // all attributes are stored in the poll's database under keys of the form option.<oid>.<key>.
  // they may only be set at construction or changed while poll is in state 'draft':

  get name(): string { return this.G.D.getp(this.p.pid, 'option.'+this._oid+'.name'); }
  set name(value: string) { this.G.D.setp(this.p.pid, 'option.'+this._oid+'.name', value); }

  get desc(): string { return this.G.D.getp(this.p.pid, 'option.'+this._oid+'.desc'); }
  set desc(value: string) { this.G.D.setp(this.p.pid, 'option.'+this._oid+'.desc', value); }

  get url(): string { return this.G.D.getp(this.p.pid, 'option.'+this._oid+'.url'); }
  set url(value: string) { this.G.D.setp(this.p.pid, 'option.'+this._oid+'.url', value); }

}