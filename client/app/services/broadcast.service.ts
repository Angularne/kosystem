import {Injectable} from "@angular/core";
import {Http} from "@angular/http";
import {Subject} from "../interfaces/subject";
import {authHeaders} from "../common/headers";

@Injectable()
export class BroadcastService {

  subject: Subject;

  constructor(private http: Http) { }


  createBroadcast(broadcast) {
    if (this.subject) {
      return this.http.post(`api/subject/${this.subject.code}/broadcast`, JSON.stringify(broadcast), {
         headers: authHeaders()
       });
    } else {
      console.error("Subject not set in BroadcastService");
    }
  }

  deleteBroadcast(id: string) {
    if (this.subject) {
      return this.http.delete(`api/subject/${this.subject.code}/broadcast/${id}`, {
         headers: authHeaders()
       });
    } else {
      console.error("Subject not set in BroadcastService");
    }
  }
}
