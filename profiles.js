'use strict';

module.exports = function(options) {
  var seneca = this;

  var PARENT_GUARDIAN_PROFILE_ENTITY = 'cd/profiles';
  var plugin = 'cd-profiles';
  var _ = require('lodash');
  var async = require('async');
  var uuid = require('node-uuid');

  var mentorPublicFields = [
    'name',
    'languagesSpoken',
    'programmingLanguages',
    'linkedin',
    'twitter',
    'userTypes',
    'dojos'
  ];

  var championPublicFields = [
    'name',
    'languagesSpoken',
    'programmingLanguages',
    'linkedin',
    'twitter',
    'userTypes',
    'projects',
    'notes',
    'dojos'
  ];

  var attendeeO13PublicFields = [
    'alias',
    'linkedin',
    'twitter',
    'badges',
    'userTypes'
  ];

  var fieldWhiteList = {
    'mentor': mentorPublicFields,
    'champion': championPublicFields,
    'attendee-o13': attendeeO13PublicFields
  };

  var allowedOptionalFieldsYouth = ['dojos', 'linkedin', 'twitter', 'badges'];
  var allowedOptionalFieldsChampion = ['notes', 'projects'];

  var allowedOptionalFields = {
    'champion': allowedOptionalFieldsChampion,
    'attendee-o13': allowedOptionalFieldsYouth
  };

  var immutableFields = ['email', 'userType'];

  var youthBlackList = ['name'];


  //var userTypes = ['champion', 'mentor', 'parent-guardian', 'attendee-o13', 'attendee-u13'];
  //var userTypes = ['attendee-u13', 'attendee-o13', 'parent-guardian', 'mentor', 'champion'];


  seneca.add({role: plugin, cmd: 'create'}, cmd_create);
  seneca.add({role: plugin, cmd: 'list'}, cmd_list);
  seneca.add({role: plugin, cmd: 'save-youth-profile'}, cmd_save_youth_profile);
  seneca.add({role: plugin, cmd: 'save'}, cmd_save);
  seneca.add({role: plugin, cmd: 'update-youth-profile'}, cmd_update_youth);
  seneca.add({role: plugin, cmd: 'invite-parent-guardian'}, cmd_invite_parent_guardian);
  seneca.add({role: plugin, cmd: 'search'}, cmd_search);
  seneca.add({role: plugin, cmd: 'accept-invite'}, cmd_accept_invite);


  function cmd_search(args, done){
    if(!args.query){
      return done(new Error('Empty query'));
    }

    seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).list$(args.query, done);
  }

  function cmd_create(args, done){
    var profile = args.profile;
    profile.userId = args.user;

    if(profile.id){
      profile = _.omit(profile, immutableFields);
    }

    seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).save$(profile, function(err, profile){
      if(err){
        return done(err);
      }

      var query = {userId: profile.userId};
      seneca.act({role: 'cd-profiles', cmd: 'list', query: query, user: args.user}, done);
    });
  }

  //TODO: clean up with async

  function cmd_save_youth_profile(args, done){
    var profile = args.profile;
    profile.parents = [];
    profile.parents.push(args.user);

    if(profile.id){
      profile = _.omit(profile, immutableFields);
    }

    var initUserType =  profile.userTypes[0];
    var password = profile.password;

    var nick = profile.alias || profile.name;
    
    var user = {
      name: profile.name,
      nick: nick,
      email: profile.email,
      initUserType: {name : initUserType},
      password: password,
      roles: ['basic-user']
    };
  
    if(initUserType === 'attendee-o13'){
    
      seneca.act({role: 'user', cmd: 'register'}, user ,function(err, data){
        if(err){
          return done(err);
        }

        //TODO update errors on front-end
        if(!data.ok){
          return done(data.why);
        }

        profile.userId = data && data.user && data.user.id;
        profile.userType = data && data.user && data.user.initUserType && data.user.initUserType.name;
        
        profile = _.omit(profile,['userTypes', 'password']);

        saveChild(profile, args.user , done);

      });
    } else if(initUserType === 'attendee-u13') {
      //If the child is under 13 create a sys_user object with is_under_13 set to true.
      //Delete email and password so this user can't login.
      delete user.email;
      delete user.password;
      
      user.isUnder_13 = true;

      seneca.act({role: 'user', cmd: 'register'}, user, function (err, data) {
        if(err) return done(err);
        if(!data.ok) return done(data.why);

        profile.userId = data && data.user && data.user.id;
        profile.userType = data && data.user && data.user.initUserType && data.user.initUserType.name;
        
        profile = _.omit(profile,['userTypes', 'password']);

        saveChild(profile, args.user , done);
      });

    }
  }

  function cmd_update_youth(args, done){
    if(!_.contains(args.profile.parents, args.user)){
      return done(new Error('Not authorized to update profile'));
    }
    var profile = args.profile;
    var derivedFields = ['password','userTypes', 'myChild', 'ownProfileFlag', 'dojos'];

    var fieldsToBeRemoved = _.union(derivedFields, immutableFields);
    
    profile = _.omit(profile, fieldsToBeRemoved);
    seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).save$(profile, function(err, profile){
      if(err){
        return done(err);
      }

      return done(null, profile);
    });
  }

  function saveChild(profile, parentId, done){
    if(_.contains(profile.parents, parentId)){
      seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).save$(profile, function(err, profile){
        if(err){
          return done(err);
        }

        seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).list$({userId: parentId}, function(err, results){
          var parent = results[0];

          if(err){
            return done(err);
          }

          parent.children = parent.children ? parent.children : [];
          parent.children.push(profile.userId);

          parent.save$(function(err){
            if(err){
              return done(err);
            }

            return done(null, profile);
          });
        });

      });
    } else {
      return done(new Error('Cannot save child'));
    }
  }

  function cmd_list(args, done){
    var query = args.query;
    var publicFields = [];

    async.waterfall([
      getProfile,
      getUsersDojos,
      getDojosForUser,
      assignUserTypes,
      addFlags,
      optionalFieldsFilter,
      privateFilter,
      publicProfilesFilter,
      under13Filter,
      resolveChildren
      ],function(err, profile){
        if(err){
          return done(err);
        }

        return done(null, profile);
      });

    function getProfile(done){
      var query = args.query;
      
      if(!query.userId){
        return done(new Error('Internal Error'));
      }

      var publicFields = [];
      seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).list$({userId:query.userId}, function(err, results){
        if(err){
          return done(err);
        }

        var profile = results[0];
        if(!profile || !profile.userId){
          return done(new Error('Invalid Profile'));
        }

        return done(null, profile);
      });
    }

    function getUsersDojos(profile, done){
      var query = {userId: profile.userId};

      seneca.act({role: 'cd-dojos', cmd: 'load_usersdojos', query: {userId: query.userId}}, function(err, usersDojos){
        if(err){
          return done(err);
        }

        return done(null, profile, usersDojos);
      });
    }

    function getDojosForUser(profile, usersDojos, done){

      seneca.act({role: 'cd-dojos', cmd: 'dojos_for_user', id: profile.userId}, function(err, dojos){
        if(err){
          return done(err);
        }

        profile.dojos = _.map(dojos, function(dojo){
          return {id: dojo.id, name: dojo.name, urlSlug: dojo.urlSlug};
        });

        return done(null, profile, usersDojos);
      });
    }

    function assignUserTypes(profile, usersDojos, done){
      profile.userTypes = [];

      if(_.isEmpty(usersDojos)){
        profile.userTypes.push(profile.userType);
      } else {
        profile.userTypes = _.flatten(_.pluck(usersDojos, 'userTypes'));
        profile.userTypes.push(profile.userType);
      }

      return done(null, profile);
    }

    function addFlags(profile, done){
      profile.ownProfileFlag = profile && profile.userId === args.user ? true : false;
      profile.myChild = _.contains(profile.parents, args.user) ? true : false;

      return done(null, profile);
    }

    function optionalFieldsFilter(profile, done){
      var allowedFields = [];
      
      if(_.contains(profile.userTypes, 'attendee-o13')){
        allowedFields = _.union(allowedFields, allowedOptionalFields['attendee-o13']);
      }

      if(_.contains(profile.userTypes, 'champion')){
        allowedFields = _.union(allowedFields, allowedOptionalFields['champion']);
      }

      if(!profile.ownProfileFlag && !profile.myChild){
        _.forOwn(profile.optionalHiddenFields, function(value, key){
          if(value && _.contains(allowedFields, key)){
            profile = _.omit(profile, key);
          }
        });
      }

      return done(null, profile);
    }

    function privateFilter(profile, done){
      if(profile.ownProfileFlag || profile.myChild){
        return done(null, profile);
      }

      if(profile.private){
        profile = {};
      }

      return done(null, profile);
    }
    //TODO cdf-admin role should be able to see all profiles
    function publicProfilesFilter(profile, done){
      var publicProfileFlag = !profile.ownProfileFlag && 
                              !profile.myChild &&
                              ( !_.contains(profile.userTypes, 'attendee-u13') || !_.contains(profile.userTypes, 'parent-guardian')); 
      
      if(publicProfileFlag){
         _.each(profile.userTypes, function(userType) {
          publicFields = _.union(publicFields, fieldWhiteList[userType]);
        });

        if(_.contains(profile.userTypes, 'attendee-o13')){
          publicFields = _.remove(publicFields, function(publicField){
            var idx =  youthBlackList.indexOf(publicField);

            return idx > -1 ? false : true;
          });
        }

        profile = _.pick(profile, publicFields);

        return done(null, profile);

      } else {
        return done(null, profile);
      }
    }

    function under13Filter(profile, done){
      //Ensure that only parents of children can retrieve their full public profile
      if(_.contains(profile.userTypes, 'attendee-u13') && !_.contains(profile.parents, args.user)){

        profile = {};
        return done(null, profile);
      }

      return done(null, profile);
    }


    function resolveChildren(profile, done){
      var resolvedChildren = [];

      if(!_.isEmpty(profile.children) && _.contains(profile.userTypes, 'parent-guardian')){
        async.each(profile.children, function(child, callback){
          seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).list$({userId: child}, function(err, results){
            if(err){
              return callback(err);
            } 
            resolvedChildren.push(results[0]);
            return callback();
          });
        }, function(err){
          if(err){
            return done(err);
          }

          profile.resolvedChildren = resolvedChildren;

          return done(null, profile);
        });
      } else {
        profile.resolvedChildren = resolvedChildren;

        return done(null, profile);
      }
    }
  }

  function cmd_save(args, done) {
    var profile = args.profile;
    seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).save$(profile, done);
  }

  function cmd_invite_parent_guardian(args, done){
    var inviteToken = uuid.v4();
    var data = args.data;
    var invitedParentEmail = data.invitedParentEmail;
    var childId = data.childId;
    var requestingParentId = args.user;
    
    var childQuery = {
      userId: childId
    };

    var parentQuery = {
      userId: requestingParentId
    };

    async.waterfall([
      resolveChild,
      resolveRequestingParent,
      updateParentProfile,
      sendEmail,
    ], done);


    function resolveChild(done){
      seneca.act({role: plugin, cmd: 'search'}, {query: childQuery}, function(err, results){
        if(err){
          return done(err);
        }

        if(_.isEmpty(results)){
          return done(new Error('Unable to find child profile'));
        }

        if(!_.contains(results[0].parents, args.user)){
          return done(new Error('Not an existing parent or guardian'));
        }

        done(null, results[0]);
      });
    }

    function resolveRequestingParent(childProfile, done){
      seneca.act({role: plugin, cmd: 'search'}, {query: parentQuery}, function(err, results){
        if(err){
          return done(err);
        }

       if(_.isEmpty(results)){
          return done(new Error('Unable to find parent profile'));
        }


        var parentProfile = results[0];
        return done(null, parentProfile, childProfile);
      });
    }

    function updateParentProfile(parentProfile, childProfile, done){
      var timestamp = new Date();
      
      var inviteRequest = {
        token: inviteToken,
        invitedParentEmail: invitedParentEmail,
        childProfileId: childProfile.userId,
        timestamp: timestamp,
        valid: true
      };

      if(!parentProfile.inviteRequests){
        parentProfile.inviteRequests = [];
      }

      parentProfile.inviteRequests.push(inviteRequest);
      
      parentProfile.inviteRequests = _.chain(parentProfile.inviteRequests)
        .sortBy(function(inviteRequest){
          return inviteRequest.timestamp;
        })
        .reverse()
        .value();


      seneca.act({role: plugin, cmd: 'save'}, {profile: parentProfile},function(err, parentProfile){
        if(err){
          return done(err);
        }

        done(err, parentProfile, childProfile, inviteRequest);
      });
    }

    function sendEmail(parentProfile, childProfile, inviteRequest, done){
      if(!childProfile || !parentProfile){
        return done(new Error('An error has occured while sending email'));
      }

      var content = {
        link: 'http://localhost:8000/accept-parent-guardian-request/' + parentProfile.userId + '/' + childProfile.userId + '/' + inviteToken,
        childName: childProfile.name,
        parentName: parentProfile.name 
      };


      var code = 'invite-parent-guardian';
      var to =  inviteRequest.invitedParentEmail;

      seneca.act({role:'email-notifications', cmd: 'send', to:to, content:content, code: code}, done);
    }

  }

  function cmd_accept_invite(args, done){
    var data = args.data;
    var inviteToken = data.inviteToken;
    var childProfileId = data.childProfileId;
    var parentProfileId = data.parentProfileId;

    async.waterfall([
      getParentProfile,
      getChildProfile,
      getInvitedParentProfile,
      validateInvite,
      updateInviteParentProfile,
      updateChildProfile,
      invalidateInvitation
    ], function(err){
      if(err){
        return done(err);
      }

      return done();
    });

    function getParentProfile(done){
      seneca.act({role: plugin, cmd: 'search'}, {query: {userId : parentProfileId}}, function(err, results){
        if(err){
          return done(err);
        }

        if(_.isEmpty(results)){
          return done(new Error('Invalid invite'));
        }

        var parent =  results[0];

        if(!_.contains(parent.children, childProfileId)){
          return done(new Error('Cannot add child'));
        }

        return done(null, parent);
      });
    }

    function getChildProfile(parent, done){
      seneca.act({role: plugin, cmd: 'search'}, {query: {userId: childProfileId}}, function(err, results){
        if(err){
          return done(err);
        }

        if(_.isEmpty(results)){
          return done(new Error('Invalid invite'));
        }

        return done(null, parent, results[0]);
      });
    }

    function getInvitedParentProfile (parent, childProfile, done){
      if(!args && args.user){
        return done(new Error('An error occured while attempting to get profile'));
      }
      seneca.act({role: plugin, cmd: 'search'}, {query: {userId: args.user}}, function(err, results){
        if(err){
          return done(err);
        }
        
        if(_.isEmpty(results)){
          return done(new Error('An error occured while attempting to get profile'));
        }

        return done(null, parent, childProfile, results[0]);
      });
    }


    
    function validateInvite(parent, childProfile, invitedParent ,done){
      var inviteRequests = parent.inviteRequests;
      var foundInvite = _.find(inviteRequests, function(inviteRequest){
        return  inviteToken === inviteRequest.token &&
                childProfile.userId === inviteRequest.childProfileId &&
                invitedParent.email === inviteRequest.invitedParentEmail && 
                inviteRequest.valid;
      });

      //Check if user was registered as parent
      if(parent.userType !== 'parent-guardian'){
        return done(new Error('Invitee is not a parent/guardian'));
      }

      //Ensure that same parent cannot be added twice
      if(_.contains(childProfile.parents, invitedParent.userId)){
        return done(new Error('Invitee is already a parent of child'));
      }
      
      if(!foundInvite){
        return done(new Error('Invalid invite'));
      } else { 
        return done(null, parent, invitedParent, childProfile);
      }
    }

    function updateInviteParentProfile(parent, invitedParent, childProfile, done){
      if(!invitedParent.children) {
        invitedParent.children = [];
      }

      invitedParent.children.push(childProfileId);

      invitedParent.save$(function(err, invitedParent){
        if(err){
          return done(err);
        }

        return done(null, parent, invitedParent, childProfile);
      });
    }

    function updateChildProfile(parent, invitedParent, childProfile, done){
      if(!childProfile.parents){
        childProfile.parents = [];
      }

      childProfile.parents.push(invitedParent.userId);

      childProfile.save$(function(err, child){
        if(err){
          return done(err);
        }

        return done(null, parent, invitedParent, childProfile);
      });
    }

    function invalidateInvitation(parent, invitedParent, childProfile, done){
      var inviteRequests = parent.inviteRequests;
      var foundInvite = _.find(inviteRequests, function(inviteRequest){
        return  inviteToken === inviteRequest.token &&
                childProfile.userId === inviteRequest.childProfileId &&
                invitedParent.email === inviteRequest.invitedParentEmail;
      });

      foundInvite.valid = false;

      parent.save$(done);
    }
  }



  return {
    name: plugin
  };

};