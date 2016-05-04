import {Injectable} from '@angular/core';
import {User} from '../interfaces/user';
import {Subject, Queue, Broadcast} from '../interfaces/subject';

let SERVER_ADDRESS = location.host;

@Injectable()
export class SocketService {

  private socket: SocketIOClient.Socket;
  private subject: Subject;

  constructor(){}


  open(subject: Subject) {
    if (!this.socket && subject)
    this.subject = subject;
    this.socket = io.connect(SERVER_ADDRESS + '/' + subject.code);

    /** TODO: Authenticate */

    this.socket.on('queue', (queue) => {this.onQueue(queue);});
    this.socket.on('broadcast', (broadcast) => {this.onBroadcast(broadcast);});

  }

  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.subject = null;
  }


  private onQueue(queue: Queue) {
    this.subject.queue = queue;
    this.subject.queue.list = queue.list.sort((a: any, b: any) => {
      return a.position - b.position;
    });
  }

  private onBroadcast(broadcasts: Broadcast[]) {
    this.subject.broadcasts = broadcasts;
  }


}
