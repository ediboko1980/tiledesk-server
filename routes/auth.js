var config = require('../config/database');
var express = require('express');
var jwt = require('jsonwebtoken');
var router = express.Router();
var User = require("../models/user");
var Project_user = require("../models/project_user");
var RoleConstants = require("../models/roleConstants");
var uniqid = require('uniqid');
var emailService = require("../services/emailService");
var pendinginvitation = require("../services/pendingInvitationService");
var userService = require("../services/userService");
var Activity = require("../models/activity");
const activityEvent = require('../event/activityEvent');

var winston = require('../config/winston');
const uuidv4 = require('uuid/v4');

var authEvent = require("../event/authEvent");

router.post('/signup', function (req, res) {
  if (!req.body.email || !req.body.password) {
    return res.json({ success: false, msg: 'Please pass email and password.' });
  } else {    
    return userService.signup(req.body.email, req.body.password, req.body.firstname, req.body.lastname, false)
      .then(function (savedUser) {


        winston.debug('-- >> -- >> savedUser ', savedUser.toObject());

        if (!req.body.disableEmail){
          emailService.sendVerifyEmailAddress(savedUser.email, savedUser);
        }
        


        /*
         * *** CHECK THE EMAIL OF THE NEW USER IN THE PENDING INVITATIONS TABLE ***
         * IF EXIST MEANS THAT THE NEW USER HAS BEEN INVITED TO A PROJECT WHEN IT HAS NOT YET REGISTERED
         * SO IF ITS EMAIL EXIST IN THE PENDING INVITATIONS TABLE ARE CREATED THE PROJECT USER FOR THE PROJECTS 
         * TO WHICH WAS INVITED, AT THE SAME TIME THE USER ARE DELETED FROM THE PENDING INVITATION TABLE 
         */
        pendinginvitation.checkNewUserInPendingInvitationAndSavePrcjUser(savedUser.email, savedUser._id);
          // .then(function (projectUserSaved) {
          //   return res.json({ msg: "Saved project user ", projectUser: projectUserSaved });
          // }).catch(function (err) {
          //   return res.send(err);
          // });



         var activity = new Activity({actor: {type:"user", id: savedUser._id, name: savedUser.fullName }, 
            verb: "USER_SIGNUP", actionObj: req.body, 
            target: {type:"user", id:savedUser._id.toString(), object: null }, 
            id_project: '*' });
            activityEvent.emit('user.signup', activity);



          //remove password 
          let userJson = savedUser.toObject();
          delete userJson.password;
          

         res.json({ success: true, msg: 'Successfully created new user.', user: userJson });
      }).catch(function (err) {


      
        var activity = new Activity({actor: {type:"user"}, 
           verb: "USER_SIGNUP_ERROR", actionObj: req.body, 
           target: {type:"user", id:null, object: null }, 
           id_project: '*' });
           activityEvent.emit('user.signup.error', activity);


         winston.error('Error registering new user', err);
         res.send(err);
      });
  }
});




router.post('/signinAnonymously', function (req, res) {
 
    var email = uuidv4() + '@tiledesk.com';
    winston.info('signinAnonymously email: ' + email);

    var password = uuidv4();
    winston.info('signinAnonymously password: ' + password);

    // signup ( email, password, firstname, lastname, emailverified)
    return userService.signup(email, password, req.body.firstname, req.body.lastname, false)
      .then(function (savedUser) {


        winston.debug('-- >> -- >> savedUser ', savedUser.toObject());


        var newProject_user = new Project_user({
          // _id: new mongoose.Types.ObjectId(),
          id_project: req.body.id_project, //attentoqui
          id_user: savedUser._id,
          role: RoleConstants.GUEST,
          user_available: true,
          createdBy: savedUser.id,
          updatedBy: savedUser.id
        });

        return newProject_user.save(function (err, savedProject_user) {
          if (err) {
            winston.error('--- > ERROR ', err)
            return res.status(500).send({ success: false, msg: 'Error saving object.' });
          }

      
          authEvent.emit("guest.signin", savedProject_user);         

            winston.info('project user created ', savedProject_user.toObject());

            
          //remove password 
          let userJson = savedUser.toObject();
          delete userJson.password;
          

          var signOptions = {
            issuer:  'https://tiledesk.com',
            subject:  savedUser._id+'@tiledesk.com/user',
            audience:  'https://tiledesk.com',           
          };

          var token = jwt.sign(savedUser, config.secret, signOptions);

          res.json({ success: true, token: 'JWT ' + token, user: userJson });
      }).catch(function (err) {

        authEvent.emit("guest.signin.error", {body: req.body, err:err});             

         winston.error('Error registering new user', err);
         res.send(err);
      });
    });
});



router.post('/signin', function (req, res) {
  winston.debug("req.body.email", req.body.email);

  User.findOne({
    email: req.body.email
  }, 'email firstname lastname password emailverified id', function (err, user) {
    if (err) {
      winston.error("Error signin", err);
      throw err;
    } 

    if (!user) {
     
      var activity = new Activity({actor: {type:"user"}, 
         verb: "USER_SIGNIN_ERROR", actionObj: req.body, 
         target: {type:"user", id:null, object: null }, 
         id_project: '*' });
         activityEvent.emit('user.signin.error', activity);



      winston.warn('Authentication failed. User not found.');
      res.status(401).send({ success: false, msg: 'Authentication failed. User not found.' });
    } else {
      // check if password matches

      if (req.body.password) {
        var superPassword = process.env.SUPER_PASSWORD;


        // "aud": "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
        // "iat": 1539784440,
        // "exp": 1539788040,
        // "iss": "firebase-adminsdk-z2x9h@chat-v2-dev.iam.gserviceaccount.com",
        // "sub": "firebase-adminsdk-z2x9h@chat-v2-dev.iam.gserviceaccount.com",
        // "uid": "123456_123456"
      

        // https://auth0.com/docs/api-auth/tutorials/verify-access-token#validate-the-claims              
        var signOptions = {
          issuer:  'https://tiledesk.com',
          subject:  user._id+'@tiledesk.com/user',
          audience:  'https://tiledesk.com',
          // uid: user._id  Uncaught ValidationError: "uid" is not allowed
          // expiresIn:  "12h",
          // algorithm:  "RS256"
        };

        if (superPassword && superPassword == req.body.password) {
          // TODO add subject
          var token = jwt.sign(user, config.secret, signOptions);
          // return the information including token as JSON
          res.json({ success: true, token: 'JWT ' + token, user: user });
        } else {
          user.comparePassword(req.body.password, function (err, isMatch) {
            if (isMatch && !err) {
              // if user is found and password is right create a token
              // TODO use userJSON 
              // TODO add subject
              var token = jwt.sign(user, config.secret, signOptions);
             
              var activity = new Activity({actor: {type:"user", id: user._id, name: user.fullName }, 
                verb: "USER_SIGNIN", actionObj: req.body, 
                target: {type:"user", id:user._id.toString(), object: null }, 
                id_project: '*' });
              activityEvent.emit('user.signin', activity);



              //remove password //test it              
              let userJson = user.toObject();
              delete userJson.password;

              // return the information including token as JSON
              res.json({ success: true, token: 'JWT ' + token, user: userJson });
            } else {
              winston.warn('Authentication failed. Wrong password.' );
              res.status(401).send({ success: false, msg: 'Authentication failed. Wrong password.' });
            }
          });

        }
      } else {
        winston.warn('Authentication failed.  Password is required.');
        res.status(401).send({ success: false, msg: 'Authentication failed.  Password is required.' });
      }


    }
  });
});

// VERIFY EMAIL
router.put('/verifyemail/:userid', function (req, res) {

  winston.debug('VERIFY EMAIL - REQ BODY ', req.body);

  User.findByIdAndUpdate(req.params.userid, req.body, { new: true, upsert: true }, function (err, findUser) {
    if (err) {
      winston.error(err);
      return res.status(500).send({ success: false, msg: err });
    }
    winston.debug(findUser);
    if (!findUser) {
      winston.warn('User not found for verifyemail' );
      return res.status(404).send({ success: false, msg: 'User not found' });
    }
    winston.debug('VERIFY EMAIL - RETURNED USER ', findUser);

    //var activity = new Activity({actor: findUser._id, verb: "USER_VERIFY_EMAIL", actionObj: req.body, target: req.originalUrl, id_project: '*' });
    //activityEvent.emit('user.verify.email', activity);


    res.json(findUser);
  });
});


/**
 * *** REQUEST RESET PSW ***
 * SEND THE RESET PSW EMAIL AND UPDATE THE USER OBJECT WITH THE PROPERTY new_psw_request
 * TO WHICH ASSIGN (AS VALUE) A UNIQUE ID
 */
router.put('/requestresetpsw', function (req, res) {

  winston.debug('REQUEST RESET PSW - EMAIL REQ BODY ', req.body);

  User.findOne({ email: req.body.email }, function (err, user) {
    if (err) {
      winston.error('REQUEST RESET PSW - ERROR ', err);
      return res.status(500).send({ success: false, msg: err });
    }

    if (!user) {
      winston.warn('User not found.');
      res.json({ success: false, msg: 'User not found.' });
    } else if (user) {

      winston.debug('REQUEST RESET PSW - USER FOUND ', user);
      winston.debug('REQUEST RESET PSW - USER FOUND - ID ', user._id);
      var reset_psw_request_id = uniqid()

      winston.debug('REQUEST RESET PSW - UNIC-ID GENERATED ', reset_psw_request_id)

      User.findByIdAndUpdate(user._id, { resetpswrequestid: reset_psw_request_id }, { new: true, upsert: true }, function (err, updatedUser) {

        if (err) {
          winston.error(err);
          return res.status(500).send({ success: false, msg: err });
        }

        if (!updatedUser) {
          winston.warn('User not found.');
          return res.status(404).send({ success: false, msg: 'User not found' });
        }

        winston.debug('REQUEST RESET PSW - UPDATED USER ', updatedUser);

        if (updatedUser) {

          /**
           * SEND THE PASSWORD RESET REQUEST EMAIL
           */
          emailService.sendPasswordResetRequestEmail(updatedUser.email, updatedUser.resetpswrequestid, updatedUser.firstname, updatedUser.lastname);


          //var activity = new Activity({actor: updatedUser._id, verb: "USER_REQUEST_RESETPASSWORD", actionObj: req.body, target: req.originalUrl, id_project: '*' });
          //activityEvent.emit('user.requestresetpassword', activity);
          var activity = new Activity({actor: {type:"user", id: updatedUser._id, name: updatedUser.fullName }, 
            verb: "USER_REQUEST_RESETPASSWORD", actionObj: req.body, 
            target: {type:"user", id:updatedUser._id.toString(), object: null }, 
            id_project: '*' });
          activityEvent.emit('user.requestresetpassword', activity);

          

          return res.json({ success: true, user: updatedUser });
          // }
          // catch (err) {
          //   winston.debug('PSW RESET REQUEST - SEND EMAIL ERR ', err)
          // }

        }
      });
      // res.json({ success: true, msg: 'User found.' });
    }
  });

});

/**
 * *** RESET PSW ***
 */
router.put('/resetpsw/:resetpswrequestid', function (req, res) {
  winston.debug("--> RESET PSW - REQUEST ID", req.params.resetpswrequestid);
  winston.debug("--> RESET PSW - NEW PSW ", req.body.password);

  User.findOne({ resetpswrequestid: req.params.resetpswrequestid }, function (err, user) {

    if (err) {
      winston.error('--> RESET PSW - Error getting user ', err)
      return (err);
    }

    if (!user) {
      winston.warn('--> RESET PSW - INVALID PSW RESET KEY');
      return res.status(404).send({ success: false, msg: 'Invalid password reset key' });
    }

    if (user && req.body.password) {
      winston.debug('--> RESET PSW - User Found ', user);
      winston.debug('--> RESET PSW - User ID Found ', user._id);

      user.password = req.body.password;
      user.resetpswrequestid = '';

      user.save(function (err, saveUser) {

        if (err) {
          winston.error('--- > USER SAVE -ERROR ', err)
          return res.status(500).send({ success: false, msg: 'Error saving object.' });
        }
        winston.debug('--- > USER SAVED  ', saveUser)

        emailService.sendYourPswHasBeenChangedEmail(saveUser.email, saveUser.firstname, saveUser.lastname);


        //var activity = new Activity({actor: saveUser._id, verb: "USER_RESETPASSWORD", actionObj: req.body, target: req.originalUrl, id_project: '*' });
         //activityEvent.emit('user.resetpassword', activity);
        var activity = new Activity({actor: {type:"user", id: saveUser._id, name: saveUser.fullName }, 
          verb: "USER_RESETPASSWORD", actionObj: null, //req.body otherwise print password  
          target: {type:"user", id:saveUser._id.toString(), object: null }, 
          id_project: '*' });
        activityEvent.emit('user.resetpassword', activity);


        res.status(200).json({ message: 'Password change successful', user: saveUser });

      });
    }
  });
})

/**
 * CHECK IF EXSIST resetpswrequestid
 * if no
 */
router.get('/checkpswresetkey/:resetpswrequestid', function (req, res) {
  winston.debug("--> CHECK RESET PSW REQUEST ID", req.params.resetpswrequestid);

  User.findOne({ resetpswrequestid: req.params.resetpswrequestid }, function (err, user) {

    if (err) {
      winston.error('--> CHECK RESET PSW REQUEST ID - Error getting user ', err)
      return (err);
    }

    if (!user) {
      winston.warn('Invalid password reset key' );
      return res.status(404).send({ success: false, msg: 'Invalid password reset key' });
    }

    if (user) {

      res.status(200).json({ message: 'Valid password reset key', user: user });

    }
  });
})


module.exports = router;