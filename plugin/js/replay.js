// replay.js

define([
  "underscore",
  "util"
], function( _ ){

  var Replay = function(){

    //Private methods

    function guidGenerator() {
      var S4 = function() {
        return (((1+Math.random())*0x10000)|0).toString(16).substring(1);
      };
      return (S4()+S4()+"-"+S4()+"-"+S4()+"-"+S4()+"-"+S4()+S4()+S4());
    }

    function genChunkKey( ns , min ){
      return clean(JSON.stringify(ns)) + "|" + clean(JSON.stringify(min));
    }


    function rewind( collections , shards , chunks , changeLogData , startIdx , endIdx ){
      var shardMap = {};
      var collMap = {};
      var data = changeLogData;
      var idx = startIdx;
      while( idx > endIdx ){
        collMap[data[idx].ns] = data[idx].ns;
        switch(data[idx].what){
        case "split" : {

          var leftData =  chunks[ genChunkKey( data[idx].ns , data[idx].details.left.min ) ];
              rightData = chunks[ genChunkKey( data[idx].ns , data[idx].details.right.min ) ];

          if( typeof leftData != "undefined" && typeof rightData != "undefined" ){

            var _id = leftData.ns + "-_id_" + guidGenerator() ,
                lastmod = { t : data[idx].details.before.lastmod.t , 
                            i : data[idx].details.before.lastmod.i } ,
                ns = data[idx].ns ,
                min = leftData.min ,
                max = rightData.max ,  
                shard = leftData.shard;
    
            var origData = { _id : _id , 
                             lastmod : lastmod , 
                             ns : ns , 
                             min : min , 
                             max : max , 
                             shard : shard };
    
    
            //Remove post-split chunks from chunk map.
            delete chunks[ genChunkKey( data[idx].ns , data[idx].details.left.min ) ];
            delete chunks[ genChunkKey( data[idx].ns , data[idx].details.right.min ) ];
    
            //Insert pre-split chunk into chunk map.
            chunks[ genChunkKey( data[idx].ns , leftData.min ) ] = origData;
            console.log(chunks[genChunkKey( data[idx].ns , leftData.min )], "HERE");
          }

        }
        break;
        case "moveChunk.commit" : { 
                  console.log("MOVECHUNK");
          console.log(data[idx]);
          // var shardId = chunks[genChunkKey( data[idx].ns , data[idx].details.min )].shard;
          // shardMap[shardId] = shardId;
          // shardId = data[idx].details.from;
          // shardMap[shardId] = shardId;
          chunks[ genChunkKey( data[idx].ns , data[idx].details.min ) ].shard = data[idx].details.from;
        }
        break;
        case "moveChunk.from" : {
          // if( typeof data[idx].details.note != "undefined" && data[idx].details.note == "aborted" )
          //   console.log("---> Aborted migration detected.");
        }
        break;
        case "dropCollection" : {
          //console.log("---> Dropped collection detected.");
        }
        break;
        case "dropDatabase" : {
          //console.log("---> Dropped db detected.");
        }
        }
        idx--;
      }

      var data = { collections : collections , shards : shards , chunks : chunks };

      return data;
    }

    function fastForward( collections , shards , chunks , changeLogData , startIdx , endIdx ){
      var collMap = {};
      var shardMap = {};
      var data = changeLogData;
      var idx = startIdx;
      while ( idx <= endIdx ){
        collMap[data[idx].ns] = { _id : data[idx].ns , dropped : false };
        switch(data[idx].what){
        case "split" : {
          var oldChunk = chunks[ genChunkKey( data[idx].ns , data[idx].details.before.min ) ];

          if( typeof oldChunk == "undefined"){
            var chunk = { _id : data[idx].ns + "-_id_" + guidGenerator() , 
                          lastmod : data[idx].details.before.lastmod ,
                          ns : data[idx].ns ,
                          min : data[idx].details.before.min , 
                          max : data[idx].details.before.max ,
                          shard : data[idx].details.before.shard //undefined!
                        };
            chunks[genChunkKey( data[idx].ns , data[idx].details.before.min )] = oldChunk = chunk;
          }
          
          var shard = oldChunk.shard;
          var leftChunk = { _id : data[idx].ns + "-_id_" + guidGenerator() , 
                            lastmod : data[idx].details.left.lastmod , 
                            ns : data[idx].ns , 
                            min : data[idx].details.left.min ,
                            max : data[idx].details.left.max , 
                            shard : shard
                          };
          var rightChunk = { _id : data[idx].ns + "-_id_" + guidGenerator() ,
                             lastmod : data[idx].details.right.lastmod , 
                             ns : data[idx].ns , 
                             min : data[idx].details.right.min ,
                             max : data[idx].details.right.max ,
                             shard : shard
                           };
          // Remove pre-split chunk from chunk map.
          delete chunks[ genChunkKey( data[idx].ns , data[idx].details.before.min ) ];
          // Insert post-split chunks into chunk map.
          chunks[ genChunkKey( leftChunk.ns , leftChunk.min ) ] = leftChunk;
          chunks[ genChunkKey( rightChunk.ns , rightChunk.min ) ] = rightChunk;
          console.log("---> Split.");
        }
        break;
        case "moveChunk.commit" : {  
          var shardId = chunks[genChunkKey( data[idx].ns , data[idx].details.min )].shard;
          if( typeof shardId == "undefined" )
            chunks[genChunkKey( data[idx].ns , data[idx].details.min )].shard = shardId = data[idx].details.from;
          shardMap[shardId] = {_id : shardId};
          shardId = data[idx].details.from;
          shardMap[shardId] = {_id : shardId};
          chunks[ genChunkKey( data[idx].ns , data[idx].details.min ) ].shard = data[idx].details.to;
          // console.log("---> Migration.");
        }
        break;
        case "moveChunk.from" : {
          // if( typeof data[idx].details.note != "undefined")
          //   console.log("---> Aborted migration detected."); 
        }
        break;
        case "dropCollection" : { 
          for( var i in collections ){
            if( collections[i]._id == data[idx].ns ){
              collections[i]._id.dropped = true;
            }
          }
          // console.log("---> Dropped collection detected.");
        }
        break;
        case "dropDatabase" : {
          // console.log("---> Dropped db detected.");
        }
        }
        idx++;
      }

      var data = { collections : collections , shards : shards , chunks : chunks };

      return data;
    }

    function replay( collections , shards , chunks , changeLog , startDate , destDate ){

      var collections = _.map(collections , function(coll){ return new clone(coll); })
      var shards = _.map(shards , function(shard){ return new clone(shard); });
      var chunkMap = {};
      _.each(chunks , function(chunk){chunkMap[genChunkKey( chunk.ns , chunk.min )] = new clone(chunk); })
      var chunks = chunkMap;

      console.log(collections , shards , chunks);

      var timestamps = _.map(changeLog , function(entry){ return entry.time.$date; });
      //console.log(timestamps,startDate,destDate);
      var startIdx = _.sortedIndex(timestamps , startDate );
      var endIdx = _.sortedIndex(timestamps , destDate );

      if(startIdx == changeLog.length){
        startIdx -= 1;
      }
      else if(startIdx != 0){
        if ( timestamps[startIdx + 1] - timestamps[startIdx] > timestamps[startIdx] - timestamps[startIdx - 1])
          startIdx--;
        else startIdx ++;
      }

      if(endIdx == changeLog.length)
        endIdx -= 1;
      else if(startIdx != 0){
        if ( timestamps[endIdx + 1] - timestamps[endIdx] > timestamps[endIdx] - timestamps[endIdx - 1])
          endIdx--;
        else endIdx ++;
      }

      startIdx = timestamps.length-1;

      // Check if timestamps exist in the changelog.
      if( typeof startIdx == -1 ){
        console.log("The configAt timestamp is not in the changelog.");
        return;
      }
      if( typeof endIdx == -1 ){
        console.log("The destDate timestamp is not in the changelog.");
        return;
      }

      var direction = endIdx - startIdx > 0 ? "forward" : "rewind" ; 
      if(direction == "forward") return fastForward( collections , shards , chunks , changeLog , startIdx , endIdx );
      if(direction == "rewind")  return rewind( collections, shards , chunks , changeLog , startIdx , endIdx ); 

    }

    // Public methods
    return {
      replay : replay ,
      genChunkKey : genChunkKey
    }  
  }

  return Replay();

});