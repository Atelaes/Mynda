const {isVideoID} = require('../library/VideoIdentity');

// Starting work acknowledges the request immediately. The task owns its
// progress and terminal failure; scans/lookups never occupy the save queue.
function createTaskMethods({scan,startTagging,startSelectedTagging,cancelTagging,reportFailure,
  requireFeature = async()=>{}}) {
  const launch = (operation,scope) => {
    Promise.resolve().then(()=>requireFeature('tagging')).then(operation).catch(error=>reportFailure(error,scope));
    return {accepted:true};
  };
  return {
    'scan.start':()=>{scan();return {accepted:true};},
    'tagging.start':()=>launch(startTagging,'library'),
    'tagging.startSelected':(_event,ids)=>{
      if (!Array.isArray(ids) || !ids.length || ids.length>10000 || ids.some(id=>!isVideoID(id))) {
        throw new Error('Select valid library videos before tagging.');
      }
      return launch(()=>startSelectedTagging(ids),'selected');
    },
    'tagging.cancel':()=>{cancelTagging();return {accepted:true};}
  };
}
module.exports={createTaskMethods};
