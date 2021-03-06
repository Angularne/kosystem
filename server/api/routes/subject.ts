import express = require("express");
import {Subject, SubjectDocument, Broadcast, Task, Queue, QueueGroup, Requirement} from "../models/subject";
import {User, UserDocument} from "../models/user";
import {Location, LocationDocument} from "../models/location";
import {Request, Response, NextFunction} from "express";
import {QueueSocket} from "../socket";
import {UserSubject} from "../models/user.subject";
import {ErrorMessage} from "../models/error";



/** Router */
let router = express.Router();

/**
 * Subject
 */

 /** GET: List all subjects */
router.get("/", (req: Request, res: Response, next: NextFunction) => {

  // Check user privileges
  if (!/Admin|Teacher/i.test(req.authenticatedUser.rights)) {
    denyAccess(res);
    return;
  }

  let cond = JSON.parse(req.query.q || "{}");
  let select: string = (req.query.select || "").split(",").join(" ");
  let populate = (req.query.populate || "").split(",").join(" ").split(";");
  let pop = populate[0];
  let popselect = populate[1];


  Subject.find(cond).select("code name").lean().exec((err, user) => {
    if (!err) {
      res.json(user);
    } else {
      res.json(err);
    }
  });
});

/** GET: Get subject */
router.get("/:code", (req: Request, res: Response, next: NextFunction) => {
  let code = req.params.code;


  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code)) {
    denyAccess(res);
    return;
  }

  // Show tasks if admin, teacher or assistent
  let showTasks = true;

  Subject.aggregate().match({
    code: code
  }).append({
    $lookup: {
      from: "usersubjects",        // <collection to join>,
      localField: "_id",          // <field from the input documents>,
      foreignField: "subject",   // <field from the documents of the "from" collection>,
      as: "users"               // <output array field>
    }
  }).exec().then((subj) => {
    if (subj.length) {
      User.populate(subj[0], {
        path: "users.user broadcasts.author queue.list.helper queue.list.users users.tasks.approvedBy",
        select: "firstname lastname"
      }).then((subject) => {
        // users populated
        Location.populate(subject, {
          path: "locations",
          select: "name count image"
        }).then(subject => {
          // locations populated
          for (let user of subject.users) {
            // Remap fields
            user.firstname = user.user.firstname;
            user.lastname = user.user.lastname;
            user._id = user.user._id;

            // remove unnecessary fields
            if (user.role !== "Student" || !showTasks) {
              delete user.tasks;
            }
            delete user.__v;
            delete user.user;
            delete user.subject;


          }
          // Send subject
          res.json(subject);

        }, (err) => {
          res.json(err);
        });
      }, (err) => {
        res.json(err);
      });
    } else {
      // not found
      res.end();
    }
  }, (err) => {
    // ERROR
    res.json(err);
  });

});

/** POST: Create new subject */
router.post("/", (req: Request, res: Response, next: NextFunction) => {

  console.log("create new subject");

  if (!/admin|teacher/i.test(req.authenticatedUser.rights)) {
    return res.sendStatus(401);
  }

  // Check body
  if (!req.body.code || !req.body.name) {
    res.status(403); // Conflict
    res.json("Code or name not set");
    return;
  }

  let subject = new Subject(req.body);
  subject.save((err) => {
    if (!err) {
      res.status(201); // Created
      res.json(subject);


      let users: {
        user: string,
        subject: string,
        role: string
      }[] = req.body.users || [];

      // Add only if user is teacher
      let userFound = /admin/i.test(req.authenticatedUser.rights);

      for (let u of users) {
        u.subject = subject._id;

        // Check if user is added
        if (!userFound && String(u.user) === String(req.authenticatedUser._id)) {
          u.role = "Teacher";
          userFound = true;
        }
      }

      // Add teacher of not already added
      if (!userFound) {
        users.push({
          user: req.authenticatedUser._id,
          subject: subject._id,
          role: "Teacher"
        });
      }

      for (let user of req.body.users || []) {
        user.user = user._id;
        user.subject = subject._id;

        UserSubject.findOneAndUpdate({
          user: user.user,
          subject: user.subject
        }, {
          role: user.role
        }, {
          upsert: true
        }).exec().then((u) => {
        }, (err) => {
          console.log(err);
        });
      }

      QueueSocket.createNamespace(subject.code);
    } else {
      res.status(409).json({errmsg: "Code is alredy registered on another subject."});
    }
  });

});

/** PUT: Update Subject */
router.put("/:code", (req: Request, res: Response, next: NextFunction) => {
  let code = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher/i)) {
    denyAccess(res);
    return;
  }

  Subject.findOneAndUpdate({code: code}, req.body, {new: true}, (err, subject) => {
    if (!err || subject) {

       let user_id: string[] = [];

       for (let user of req.body.users || []) {
         user.user = user._id;
         user.subject = subject._id;

         user_id.push(user._id);

         UserSubject.findOneAndUpdate({
           user: user.user,
           subject: user.subject
         }, {
           role: user.role
         }, {
           upsert: true
         }).exec().then((u) => {
         }, (err) => {
           console.log(err);
         });
       }


       UserSubject.remove({
         subject: subject._id,
         user: {$nin: user_id}
       }).exec().then((usr) => {
       }, (err) => {
         console.log(err);
       });
      res.json(subject);
    } else {
      res.status(400).json(err);
    }
  });
});

/** POST: Add users to subject */ // Ikke i bruk
router.post("/:code/users", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher/i)) {
      denyAccess(res);
      return;
  }

  // Check data
  let students = req.body.students || [];
  let assistents = req.body.assistents || [];
  let teachers = req.body.teachers || [];

  let i = 0;
  function finished() {
    i++;
    if (i >= 0) {
      res.end();
    }
  }
  i--;
  Subject.findOneAndUpdate({code: code},
    {$addToSet: {students: {$each: students}, assistents: {$each: assistents}, teachers: {$each: teachers}}}).select("_id").exec((err, subj) => {
    if (!err && subj) {
      // Subject exists
      if (students.length) {
        i--;
        User.update({_id: {$in: students}, "subjects.subject": {$ne: subj._id}},
                    {$push: {subjects: {subject: subj._id, role: "Student"}}}, {multi: true}, (err, model) => {
          finished();
        });
      }
      if (assistents.length) {
        i--;
        User.update({_id: {$in: assistents}, "subjects.subject": {$ne: subj._id}},
                    {$push: {subjects: {subject: subj._id, role: "Assistent"}}}, {multi: true}, (err, model) => {
                      finished();
        });
      }
      if (teachers.length) {
        i--;
        User.update({_id: {$in: teachers}, "subjects.subject": {$ne: subj._id}},
                    {$push: {subjects: {subject: subj._id, role: "Teacher"}}}, {multi: true}, (err, model) => {
                      finished();
        });
      }
      finished();
    } else {
      res.json(err);
    }
  });
});

/** DELETE: Remove users from subject */ // Ikke i bruk
router.delete("/:code/users", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher/i)) {
      denyAccess(res);
      return;
  }

  // Check data
  let students = req.body.students || [];
  let assistents = req.body.assistents || [];
  let teachers = req.body.teachers || [];

  let i = 0;
  function finished() {
    i++;
    if (i >= 0) {
      res.end();
    }
  }
  i--;
  Subject.findOneAndUpdate({code: code},
    {$pullAll: {students: students, assistents: assistents, teachers: teachers}}).select("_id").exec((err, subj) => {
    if (!err && subj) {
      // Subject exists
      if (students.length) {
        i--;
        User.update({_id: {$in: students}, "subjects.subject": {$in: subj._id}},
                    {$pull: {subjects: {$elemMatch: {subject: subj._id, role: "Student"}}}}, {multi: true}, (err, model) => {
          finished();
        });
      }
      if (assistents.length) {
        i--;
        User.update({_id: {$in: assistents}, "subjects.subject": {$in: subj._id}},
                    {$pull: {subjects: {subject: subj._id, role: "Assistent"}}}, {multi: true}, (err, model) => {
                      finished();
        });
      }
      if (teachers.length) {
        i--;
        User.update({_id: {$in: teachers}, "subjects.subject": {$in: subj._id}},
                    {$pull: {subjects: {subject: subj._id, role: "Teacher"}}}, {multi: true}, (err, model) => {
                      finished();
        });
      }
      finished();
    } else {
      res.json(err);
    }
  });
});

/** PUT: Update students in subject */
router.put("/:code/students", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;
  let students = req.body.students;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher/i)) {
    return denyAccess(res);
  }


  Subject.findOne({code: code}).exec().then((subject) => {

    for (let user of students || []) {



      UserSubject.findOneAndUpdate({
        user: user,
        subject: subject._id
      }, {
        role: "Student"
      }, {
        upsert: true
      }).exec().then((u) => {
      }, (err) => {
        console.log(err);
      });
    }


    UserSubject.remove({
      subject: subject._id,
      role: "Student",
      user: {$nin: students}
    }).exec().then((usr) => {
    }, (err) => {
      console.log(err);
    });

    res.end();
  });
});

/** DELETE: Delete subject */
router.delete("/:code", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher/i)) {
    return denyAccess(res);
  }

  Subject.findOneAndRemove({code: code}, (err, sub) => {
    if (!err) {
      res.end();
      UserSubject.remove({subject: sub._id}, (err) => {
        if (err) console.log(err);
      });
    } else {
      res.status(400).json(err);
    }
  });
});

/**
 * Broadcast
 */

/** POST: Create broadcast */
router.post("/:code/broadcast", (req: Request, res: Response, next: NextFunction) => {
  let code = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    denyAccess(res);
    return;
  }

  // Check body
  if (!req.body.title) {
    return validateFailed(res, {
      field: "title",
      message: "title not set",
      value: null
    });
  }
  if (!req.body.content) {
    return validateFailed(res, {
      field: "content",
      message: "content not set",
      value: null
    });
  }


  let broadcast = {
    author: req.authenticatedUser._id,
    title: req.body.title,
    content: req.body.content,
    created: new Date()
  };

  Subject.findOneAndUpdate({code: code}, {$push: {broadcasts: broadcast}}).exec((err, subj) => {
    if (!err) {

      QueueSocket.broadcast(code);
      res.status(201);
      res.end();
    } else {
      res.status(400).json(err);
    }
  });
});

/** PUT: Update broadcast */
router.post("/:code/broadcast/:bc_id", (req: Request, res: Response, next: NextFunction) => {
  let code = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    denyAccess(res);
    return;
  }

  delete req.body.created;

  Subject.findOneAndUpdate({code: code, "broadcast._id": req.params.bc_id}, {broadcast: req.body}, (err, subj) => {
    if (!err) {
      QueueSocket.broadcast(code);
      res.end();
    } else {
      res.status(400).json(err);
    }
  });
});

/** DELETE: Delete broadcast */
router.delete("/:code/broadcast/:bc_id", (req: Request, res: Response, next: NextFunction) => {
  let code = req.params.code;
  let bc_id = req.params.bc_id;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    denyAccess(res);
    return;
  }

  Subject.update({code: code}, {$pull: {broadcasts: {_id: bc_id}}}, (err, model) => {
    if (!err) {
      QueueSocket.broadcast(code);
      res.end();
    } else {
      res.status(400).json(err);
    }
  });
});


/**
 * Queue
 */

// Timer to flush queue after it is closed
let flush: {[id: string]: NodeJS.Timer} = {};

/** PUT: Start and stop queue */
router.put("/:code/queue/", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    denyAccess(res);
    return;
  }

  let activate: boolean = req.body.activate || false;
  Subject.findOneAndUpdate({code: code}, {"queue.active": activate}).exec((err, subj) => {
    if (!err) {
      res.end();
      QueueSocket.queue(code);
    } else {
      res.json(err);
    }
  });


  // Set timeout to flush queue
  if (activate) {
    clearTimeout(flush[code]);
    delete flush[code];
  } else if (!flush[code]) {
    flush[code] = setTimeout(() => {
      Subject.findOneAndUpdate({code: code}, {"queue.list": []}).exec();
    }, 5000); // 5 Sec
  }

});

/** POST: Add users to queue */
router.post("/:code/queue", (req: Request, res: Response, next: NextFunction) => {
  let code = req.params.code;
  let users_id = req.body.users || [];

  let task: number  = +req.body.task || 1;
  let comment: string = req.body.comment || "Comment";
  let location = req.body.location;


  users_id.push(req.authenticatedUser._id);

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code)) {
    denyAccess(res);
    return;
  }

  // Check parameters
  if (!users_id) {
    res.json("Users not set");
    return;
  }

  Subject.findOne({code: code}).exec((err, subj) => {
    if (!err && subj) {
        // Subject found
        if (!subj.queue.active) {
          res.status(409);
          res.json("Queue not active");
          return;
        }
        // Find users and check access

        let users: UserDocument[];
        User.find({_id: {$in: users_id}}).lean().select("firstname lastname subjects").exec((err, usersRes) => {
          if (!err && usersRes) {
            users = usersRes;
            for (let user of users) {
              if (!hasAccess(req.authenticatedUser, code, /student/i)) {
                // Some users do not have access to subject
                res.status(409); // Conflict
                res.json("Some users do not have access to subject");
                return;
              }
             }
             // Check if users already in queue
             for (let queued of subj.queue.list) {
               for (let queuedUser of queued.users) {
                 for (let user of users) {
                   if (String(queuedUser) === String(user._id)) {
                     // Some users already in queue
                     res.status(409);
                     res.json(`${user.firstname} ${user.lastname} already in queue`);
                     return;
                   }
                 }
               }
             }
             // Add group to queue and save

             let pos = subj.queue.list.length + 1;

             let q: QueueGroup = {
               users: users_id,
               helper: null,
               timeEntered: new Date(),
               comment: comment,
               position: pos, // in queue
               task: task,
               location: location
             };

             subj.queue.list.push(q);

             subj.save((serr) => {
               if (!serr) {
                 // Success
                 res.status(201); // Created
                 res.end();

                 QueueSocket.queue(code);
               } else {
                 // Save Error
                 res.status(400);
                 res.json(serr);
               }
             });
          } else {
            res.status(400);
            res.json(err);
          }
        });
    } else {
      res.status(400).json(err);
    }
  });
});

/** PUT: Update queue item
router.put("/:code/queue/:id", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;
  let id: string = req.params.id;

  let updates = req.body;

  // Check user privileges
  if (!checkAccess(req.authenticatedUser, code)) {
    denyAccess(res);
    return;
  }
});
*/

/** PUT: Add helper to queue */
router.put("/:code/queue/:qid", (req: Request, res: Response, next: NextFunction) => {
  let code = req.params.code;
  let qid = req.params.qid;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    denyAccess(res);
    return;
  }



  Subject.findOneAndUpdate(
    {code: code, "queue.list._id": qid},
    {"queue.list.$.helper": req.authenticatedUser._id}
  ).exec((err, subj) => {
    if (!err) {
      QueueSocket.queue(code);
      res.end();
    } else {
      res.json(err);
    }
  });
});

/** DELETE: Remove group from queue */
router.delete("/:code/queue/:id", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;
  let id: string = req.params.id;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code)) {
    denyAccess(res);
    return;
  }
  // Validate if user can remove grup
  let force = hasAccess(req.authenticatedUser, code, /teacher|assistent/i);
  let cond: any = {
    code: code,
    "queue.list": {
      $elemMatch: {
          _id: id,
          users: req.authenticatedUser._id
      }
    }
  };
  if (force) {
    delete cond["queue.list"].$elemMatch.users;
  }

  Subject.findOne(cond).exec((err, sub) => {
    if (sub) {
      // Find queue group and update remaining
      // Save
      removeGroup(sub, id).save((err, s) => {
        if (!err) {
          res.end();
          QueueSocket.queue(code);

        } else {
          res.status(400).json(err);
        }
      });
    } else if (err) {
      // Error
      res.status(400).json(err);
    } else {
      // NOT FOUND OR NOT ALLOWED
      res.status(400).end();
    }
  });
});


/** DELETE: Remove self from queue */
// Må vurdere om denne skal fjernes
router.delete("/:code/queue", (req: Request, res: Response, next: NextFunction) => {
  let code = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code)) {
    denyAccess(res);
    return;
  }

  // Remove self
  Subject.update(
    {code: code, "queue.list.users": req.authenticatedUser._id},
    {$pull: {"queue.list.$.users": req.authenticatedUser._id}}
  ).exec((err, affected: any) => {
    if (!err) {
      // Check number of users left in group
      // Remove if no users left
      if (affected.nModified > 0) {

        removeEmptyQueueGroups(code).then((sub) => {
          res.end();
          QueueSocket.queue(code);
        }).catch((err) => {
          res.status(400).json(err);
          QueueSocket.queue(code);
        });
      } else {
        QueueSocket.queue(code);
        res.end(); }
    } else { res.json(err); }
  });
});

/** Find and removes empty groups */
function removeEmptyQueueGroups(code) {
  return new Promise<SubjectDocument>((resolve, reject) => {
    Subject.findOne({code: code}).exec().then((sub) => {
      let emptyGroups: QueueGroup[] = [];

      // Find empty groups
      for (let group of sub.queue.list) {
          if (group.users.length === 0) {
            emptyGroups.push(group);
          }
      }

      // Remove groups
      for (let group of emptyGroups) {
          removeGroup(sub, group._id);
      }

      // Save
      sub.save((err, res: SubjectDocument) => {
        if (!err) {
          resolve(res);
        } else {
          reject(err);
        }
      });
    }, (err) => {
      reject(err);
    });
  });
}

/** Removes group and updates positions to other groups */
function removeGroup(subject: SubjectDocument, queue_id: string) {
  // Find queue group and update remaining
  let index: number;
  let pos: number;

  for (let i = 0; i < subject.queue.list.length; i++) {
      let q = subject.queue.list[i];
      if (String(q._id) === queue_id) {
        index = i;
        pos = q.position;
        break;
      }
  }

  // remove
  subject.queue.list.splice(index, 1);

  // Update positions
  for (let q of subject.queue.list) {
      if (q.position > pos) {
        q.position--;
      }
  }

  return subject;
}


/** POST: Delay queue group */
router.post("/:code/queue/:qid/delay", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;
  let qid: string = req.params.qid;

  let delay: number = +req.body.delay;


  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    denyAccess(res);
    return;
  }

  if (isNaN(delay) || delay < 1) {
    res.status(418);
    return  res.send("delay must be greater than or equal to 1");
  }

  Subject.findOne({code: code}).exec().then((sub) => {
    // Find queue group and update remaining
    let pos: number;
    let index: number;

    for (let i = 0; i < sub.queue.list.length; i++) {
        let q = sub.queue.list[i];
        if (String(q._id) === qid) {
          pos = q.position;
          q.helper = null;
          index = i;
          break;
        }
    }

    // Limit delay
    if ((delay + pos) > sub.queue.list.length) {
      delay = sub.queue.list.length - pos;
    }
    // Update positions
    for (let q of sub.queue.list) {
        if (q.position > pos && q.position <= pos + delay) {
          q.position--;
        }
    }

    sub.queue.list[index].position += delay;

    sub.save((err, s) => {
      if (!err) {
        res.end();
        QueueSocket.queue(code);

      } else {
        res.status(400).json(err);
      }
    });

  });

  Subject.findOneAndUpdate({code: code},
  {
    // Set Delay
  }).exec().then((sub) => {
      QueueSocket.queue(code);
      res.end();
  }, (err) => {
    res.status(400).json(err);
  });


});




/** POST: Set helper on queue group */
router.post("/:code/queue/:qid/help", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;
  let qid: string = req.params.qid;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    return denyAccess(res);
  }

  Subject.findOneAndUpdate({code: code, "queue.list._id": qid},
  {"queue.list.$.helper": req.authenticatedUser._id})
  .exec().then((sub) => {
    QueueSocket.queue(code);
    res.end();
  }, (err) => {
    res.status(400).json(err);
  });
});

/** DELETE: Remove helper on queue group */
router.delete("/:code/queue/:qid/help", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;
  let qid: string = req.params.qid;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    return denyAccess(res);
  }

  Subject.findOneAndUpdate({code: code, "queue.list._id": qid},
  {"queue.list.$.helper": null})
  .exec().then((sub) => {
    QueueSocket.queue(code);
    res.end();
  }, (err) => {
    res.status(400).json(err);
  });

});




/**
 * Tasks
 */

/** POST: Add Requirement */ // ikke i bruk
router.post("/:code/requirement", (req: Request, res: Response, next: NextFunction) => {
  let code = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher/)) {
    denyAccess(res);
    return;
  }

  let requirement = req.body.requirement;
  if (requirement && requirement.start && requirement.end && requirement.required) {
    Subject.findOneAndUpdate({code: code}, {$push: {"tasks.requirements": requirement}}).exec((err) => {
      if (!err) {
        res.end();
      } else {
        res.json(err);
      }
    });
  } else {
    // Wrong data
    res.sendStatus(400);
  }
});

/** DELETE: Remove Requirement */ // ikke i bruk
router.delete("/:code/requirement/:id", (req: Request, res: Response, next: NextFunction) => {
  let code = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher/i)) {
    denyAccess(res);
    return;
  }

  Subject.findOneAndUpdate({code: code}, {$pull: {"tasks.requirements": {_id: req.params.id}}}).exec((err) => {
    if (!err) {
      res.end();
    } else {
      res.json(err);
    }
  });
});

/** POST: Add tasks to users  */
router.post("/:code/task", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    denyAccess(res);
    return;
  }

  let usersID = req.body.users;
  let task: number = +req.body.task;
  let date = new Date();

  if (!(usersID && usersID instanceof Array && usersID.length)) {
    return validateFailed(res, {
      field: "users",
      message: "users must be set and not empty",
      value: req.body.users || null
    });
  }
  if (isNaN(task) || task <= 0) {
    return validateFailed(res, {
      field: "task",
      message: "task is NaN or less than 0",
      value: req.body.task || null
    });
  }

  Subject.findOne({code: code}, (err, sub) => {
    if (!err && sub) {
      if (task <= sub.tasks.length)  {
        UserSubject.update(
          {subject: sub._id, user: {$in: usersID}, "tasks.number": {$ne: task}},
          {$push: {tasks: {
            number: task,
            date: date,
            approvedBy: req.authenticatedUser._id
          }}}).exec().then(() => {
            res.end();
          }, (err) => {
            res.status(400).json(err);
          });
        } else {
          // invlalid task number
          return validateFailed(res, {
            field: "task",
            message: "task cannot be greater than number of tasks in subject",
            value: task
          });
        }
    } else {
      res.status(400).json(err);
    }
  });
});

/** DELETE: Remove tasks from users */
router.delete("/:code/task", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    denyAccess(res);
    return;
  }
  let usersID = req.body.users;
  let task: number = req.body.task;

  // Validate
  if (!(usersID && usersID instanceof Array && usersID.length)) {
    return validateFailed(res, {
      field: "users",
      message: "users must be set and not empty",
      value: req.body.users || null
    });
  }
  if (isNaN(task) || task <= 0) {
    return validateFailed(res, {
      field: "task",
      message: "task is NaN or less than 0",
      value: req.body.task || null
    });
  }


  Subject.findOne({code: code}, (err, sub) => {
    if (!err && sub) {
      if (task <= sub.tasks.length)  {
        UserSubject.update(
          {subject: sub._id, user: {$in: usersID}, "tasks.number": task},
          {$pull: {tasks: {number: task}}}
        ).exec().then(() => {
            res.end();
          }, (err) => {
            res.status(400).json(err);
          });
        } else {
          // invlalid task number
          return validateFailed(res, {
            field: "task",
            message: "task cannot be greater than number of tasks in subject",
            value: task
          });
        }
    } else {
      res.status(400).json(err);
    }
  });
});

/** PUT: Update tasks on students in subject */
router.put("/:code/task", (req: Request, res: Response, next: NextFunction) => {
  let code: string = req.params.code;

  let users: {
    _id: string, // _id
    tasks: number[]
  }[] = req.body.users;

  let date =  new Date();

  // Check user privileges
  if (!hasAccess(req.authenticatedUser, code, /teacher|assistent/i)) {
    return denyAccess(res);
  }

  Subject.findOne({code: code}).select("tasks").lean().exec().then((sub) => {
    for (let user of users) {

      UserSubject.findOne({subject: sub._id, user: user._id}).exec().then((u) => {

        // Add tasks
        for (let t1 of user.tasks) {
          let inTasks: boolean = false;
          for (let t2 of u.tasks) {
            if (t1 === t2.number) {
              inTasks = true;
              break;
            }
          }

          if (!inTasks) {
            // Add
            u.tasks.push({
              number: t1,
              date: date,
              approvedBy: req.authenticatedUser._id
            });
          }
        }

        for (let i = 0; i < u.tasks.length; i++) {
          let t = u.tasks[i];
          if (user.tasks.indexOf(t.number) === -1) {
            u.tasks.splice(i, 1);
            i--;
          }
        }

        u.save();

      });
    }
  });

    res.status(204);
    res.end();
});

function hasAccess(user: UserDocument, code: string, role: RegExp = /.*/) {
  if (user.rights === "Admin") {
    return true;
  }

  for (let sub of user.subjects) {
    if (sub.code === code) return role.test(sub.role);
  }
  return false;
}

/**
 * Denies access
 */
function denyAccess(res: Response, message: string = "Access Denied") {
  res.status(403);
  res.json({message: message});
}

module.exports = router;

function validateFailed(res: Response, err: ErrorMessage, status: number = 400) {
  res.status(status).json(err);
}
